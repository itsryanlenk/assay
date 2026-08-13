/**
 * Bolting a Google Business Profile onto a candidate that came in through the
 * typed-URL door.
 *
 * The typed door is keyless on purpose and its price is paid by the two
 * measurements that need a second source: NAP consistency has nothing to
 * compare the site against, and the plain-words vocabulary points have no
 * category term. Both correctly mark themselves out. An operator scanning
 * their own site, or a prospect they reached by URL and can identify on
 * Google, has that second source and until now had no way to hand it over.
 *
 * TWO RULES GOVERN EVERYTHING IN THIS FILE.
 *
 * 1. This process mints every listing it attaches, from a Places response.
 *    The attach channel takes a place id and looks the listing up in the
 *    register below rather than accepting a listing object off the wire.
 *
 *    THE HONEST SCOPE OF THAT: it is a rule about this path, not a boundary
 *    the app enforces. checks:run, confirm:run and packet:generate each accept
 *    a whole Candidate from the renderer and always have, and listingOf()
 *    reads `listing.source` from that object, exactly as it has always read
 *    `candidate.source`. A renderer that lies could therefore assert a listing
 *    it never got, the same way it could already assert a Places candidate.
 *    This diff does not widen that; do not read the rule as closing it. What
 *    the register actually buys is that the operator's pick costs no second
 *    billed request, and that the ordinary path cannot attach by accident what
 *    Google never returned.
 * 2. Attaching adds a source and changes nothing else. The candidate's name,
 *    address, website and placeId are what the ledger key, the packet folder
 *    and every artifact are built from. Moving any of them re-slugs the
 *    prospect and drops earlier approval rows out of the supersede sweep,
 *    which is a bug this project has already shipped once.
 */

import { AttachedListing, Candidate, Result, err, ok } from '../../shared/types';

/**
 * A Places result, as an attachable listing.
 *
 * The adapter already maps a wire place to a Candidate, and re-deriving the
 * same fields from raw JSON in a second place is how the two copies drift, so
 * this converts rather than parses. It refuses anything that did not come from
 * Places for the same reason the type carries a source at all.
 */
export function listingFromCandidate(candidate: Candidate): AttachedListing {
  if (candidate.source !== 'google-places-new') {
    throw new Error('listingFromCandidate: only a Places result can become a listing');
  }
  return {
    placeId: candidate.placeId,
    name: candidate.name,
    address: candidate.address,
    location: candidate.location,
    website: candidate.website,
    phone: candidate.phone,
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    businessStatus: candidate.businessStatus,
    primaryType: candidate.primaryType,
    mapsUri: candidate.mapsUri,
    attachedAt: new Date().toISOString(),
    source: 'google-places-new',
  };
}

/**
 * Returns a copy of `candidate` carrying `listing`, or a refusal.
 *
 * Note what is NOT copied across: not the name, not the address, not the
 * website, not the placeId. The listing's own name and address live on the
 * listing, where the checks read them as Google's; the candidate's stay the
 * operator's. A listing whose website differs from the address the operator
 * typed does not redirect the scan either, because the operator chose what to
 * scan and a listing is frequently the thing that is out of date.
 */
export function attachListing(candidate: Candidate, listing: AttachedListing): Result<Candidate> {
  if (candidate.source === 'google-places-new') {
    return err(
      'bad_request',
      'That candidate came from the Places API and already carries its listing. Attaching a second one would leave two answers to the same question.'
    );
  }
  // Allow-list rather than deny-list. A candidate with a missing or unknown
  // source is not a typed candidate, it is something this code does not
  // recognise, and listingOf would read a listing hung on it.
  if (candidate.source !== 'operator-url') {
    return err('bad_request', 'A listing can only be attached to a business added by web address.');
  }
  if (listing.source !== 'google-places-new') {
    return err('internal', 'Only a Google Places result can be attached as a listing.');
  }
  return ok({ ...candidate, listing });
}

/** Drops the listing again, for an operator who attached the wrong business. */
export function detachListing(candidate: Candidate): Candidate {
  const { listing: _dropped, ...rest } = candidate;
  return rest;
}

// ---------------------------------------------------------------------------
// The mint register.
//
// Search-by-name shows the operator several listings to choose from, and the
// chosen one has to be attached by main rather than by the renderer, or rule 1
// above is enforced by a process that a renderer bug can lie to. Sending the
// place id back and re-fetching it would obey the rule at the cost of a second
// billed request for a listing this process already holds, so main keeps what
// it minted and attaches from memory.
//
// Session-scoped and deliberately not persisted: it exists to bridge a pick,
// not to become a stale cache of Google's data. Bounded so a long session of
// searching cannot grow it without limit.
// ---------------------------------------------------------------------------

const MAX_REMEMBERED = 200;
const minted = new Map<string, AttachedListing>();

export function rememberListings(listings: AttachedListing[]): void {
  for (const listing of listings) {
    // Re-inserting moves it to the end, so the eviction below drops the
    // least recently offered rather than an entry the operator is looking at.
    minted.delete(listing.placeId);
    minted.set(listing.placeId, listing);
  }
  while (minted.size > MAX_REMEMBERED) {
    const oldest = minted.keys().next();
    if (oldest.done) break;
    minted.delete(oldest.value);
  }
}

/** A listing this process minted earlier in the session, or null. */
export function mintedListing(placeId: string): AttachedListing | null {
  return minted.get(placeId) ?? null;
}

/** Test seam only. The register is process-global; tests need it empty. */
export function __resetRegister(): void {
  minted.clear();
}
