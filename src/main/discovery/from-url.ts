/**
 * The second door into the candidate table: a web address the operator types.
 *
 * No network call. The refusals are fetch-raw's list, applied here so the
 * reason reaches the form rather than a failed capture, and every candidate
 * this builds carries no listing fields at all.
 */

import { Candidate, Result, err, ok } from '../../shared/types';
import { refusalFor } from '../evidence/fetch-raw';

export type UrlCandidateRequest = {
  url: string;
  name: string;
  /** "Town, ST", or a town alone. Names the packet folder and nothing else. */
  town?: string;
};

/**
 * Adds https when the operator omits a scheme. Returns null on anything
 * unparseable.
 *
 * The scheme test requires either `//` or a non-numeric first character after
 * the colon, because `example.test:8080` looked like a scheme to a bare colon
 * check and came back refused as "a example.test: address". A bare
 * `user:pw@example.test` still reads as a scheme and is refused; with a scheme
 * in front it gets the credentials message below.
 */
function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[a-z][a-z0-9+.-]*:[^/\d]/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function candidateFromUrl(req: UrlCandidateRequest): Result<Candidate> {
  const name = (req.name ?? '').trim();
  if (name === '') {
    return err('bad_request', 'Enter the business name. It prints on every artifact.');
  }

  const u = parseUrl(req.url ?? '');
  if (!u) return err('bad_request', 'Enter a web address, like example.com.');

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return err('bad_request', `A ${u.protocol} address cannot be scanned. Use http or https.`);
  }

  const refusal = refusalFor(u);
  if (refusal) {
    return err('bad_request', `${refusal} is off limits by project law.`);
  }

  // Credentials in the address would ride into the evidence manifest, which is
  // a file the prospect receives.
  if (u.username !== '' || u.password !== '') {
    return err('bad_request', 'Remove the username and password from the address. Artifacts print the URLs they read.');
  }

  return ok({
    // Keyed on the host, so scanning two pages of one site reuses its row.
    placeId: `url:${u.hostname}`,
    name,
    address: (req.town ?? '').trim(),
    location: null,
    website: u.toString(),
    phone: null,
    rating: null,
    reviewCount: null,
    businessStatus: null,
    primaryType: null,
    mapsUri: null,
    discoveredAt: new Date().toISOString(),
    source: 'operator-url',
  });
}
