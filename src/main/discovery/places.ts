/**
 * Google Places API (New) Text Search adapter, the ONLY sanctioned business-
 * discovery path in this project. Scraping Google Maps HTML is prohibited by
 * project law; do not add a scraping fallback here or anywhere else.
 * PLACES_FIELD_MASK below is the single audit point for what gets billed, * every field listed is billed per Google's field-mask SKU tiers.
 * Endpoint contract (URL, headers, request/response shapes) verified against
 * Google's Places API (New) documentation on 2026-07-28.
 */

import { Candidate, Result, SearchPlacesRequest, SearchPlacesResponse, ok, err } from '../../shared/types';

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Field mask for places:searchText. `nextPageToken` has NO `places.` prefix, * it is a top-level response field, not a per-place field.
 *
 * BILLING. Google bills a request at the HIGHEST SKU tier any requested field
 * belongs to, not per field. Tier attribution for this mask (verified
 * 2026-07-28 against the Places data-fields and usage-and-billing pages):
 *
 *   Essentials  id, formattedAddress, location
 *   Pro         displayName, businessStatus, primaryType, googleMapsUri
 *   Enterprise  websiteUri, nationalPhoneNumber, rating, userRatingCount
 *
 * So this mask bills at TEXT SEARCH ENTERPRISE. Dropping the four Enterprise
 * fields would drop it to Pro, but websiteUri is what the website check needs
 * and rating/userRatingCount are what the review-response check needs, so the
 * tier is bought deliberately. Anything added here must be re-attributed above.
 */
export const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.businessStatus,places.primaryType,places.googleMapsUri,nextPageToken';

/** The tier PLACES_FIELD_MASK actually bills at. Keep in sync with the mask. */
const BILLED_SKU = 'Text Search Enterprise';
const BILLED_SKU_REASON = 'websiteUri, nationalPhoneNumber, rating, userRatingCount';

// ---------------------------------------------------------------------------
// Raw wire shapes for places:searchText. Every field is optional on the wire
// regardless of what we asked for, Google omits absent data rather than
// sending nulls, so nothing here is trusted without a guard at the read site.
// ---------------------------------------------------------------------------

interface GoogleErrorEnvelope {
  code?: number;
  message?: string;
  status?: string;
}

interface GooglePlaceRaw {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  primaryType?: string;
  googleMapsUri?: string;
}

interface GoogleSearchTextResponseRaw {
  places?: GooglePlaceRaw[];
  nextPageToken?: string;
  error?: GoogleErrorEnvelope;
}

interface PlacesSearchTextBody {
  textQuery: string;
  pageSize: number;
  pageToken?: string;
}

/** "<category> in <city>", trimmed, with internal whitespace runs collapsed. */
export function buildTextQuery(category: string, city: string): string {
  const cleanCategory = category.trim().replace(/\s+/g, ' ');
  const cleanCity = city.trim().replace(/\s+/g, ' ');
  return `${cleanCategory} in ${cleanCity}`;
}

function clampLimit(limit: number | undefined): number {
  const requested = limit ?? 10;
  if (!Number.isFinite(requested)) return 10;
  return Math.min(20, Math.max(1, Math.trunc(requested)));
}

function toDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Maps one wire place to a Candidate, or null when it lacks the minimum to be useful. */
function mapPlace(place: GooglePlaceRaw): Candidate | null {
  const placeId = place.id;
  const name = place.displayName?.text;
  if (!placeId || !name) return null;

  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  const location =
    typeof latitude === 'number' && typeof longitude === 'number' ? { lat: latitude, lng: longitude } : null;

  return {
    placeId,
    name,
    address: place.formattedAddress ?? '',
    location,
    website: place.websiteUri ?? null,
    phone: place.nationalPhoneNumber ?? null,
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    businessStatus: place.businessStatus ?? null,
    primaryType: place.primaryType ?? null,
    mapsUri: place.googleMapsUri ?? null,
    discoveredAt: new Date().toISOString(),
    source: 'google-places-new',
  };
}

/** Maps a non-2xx HTTP response to a typed Err, using Google's error envelope when present. */
function mapHttpError(status: number, googleError: GoogleErrorEnvelope | undefined): Result<SearchPlacesResponse> {
  const detail = googleError?.message;

  const lowerMessage = (googleError?.message ?? '').toLowerCase();

  const notEnabled =
    lowerMessage.includes('not been used') ||
    lowerMessage.includes('not enabled') ||
    lowerMessage.includes('disabled') ||
    lowerMessage.includes('activate');

  // Verified against the live endpoint 2026-07-28: Google answers an invalid
  // key with HTTP 400 ("API key not valid"), not 401/403. Triaging on status
  // alone would tell someone with a bad key to go audit their field mask, so
  // the message is checked before the status.
  const keyProblem =
    lowerMessage.includes('api key not valid') ||
    lowerMessage.includes('api key expired') ||
    lowerMessage.includes('invalid api key') ||
    lowerMessage.includes('api_key_invalid');

  if (notEnabled) {
    return err(
      'not_enabled',
      'Places API (New) is not enabled for this Google Cloud project. Enable "Places API (New)" and try again.',
      { detail, status }
    );
  }

  if (keyProblem) {
    return err('auth', 'Google rejected the API key as invalid. Check it in Settings.', {
      detail,
      status,
    });
  }

  if (status === 400) {
    return err(
      'bad_request',
      'Google Places API rejected the request. The field mask or query is the usual culprit.',
      { detail, status }
    );
  }

  if (status === 401 || status === 403) {
    return err(
      'auth',
      'Google rejected the API key. It may be restricted to other APIs, referrers, or IPs.',
      { detail, status }
    );
  }

  if (status === 429) {
    return err('quota', 'Google Places API quota exceeded. Wait and try again, or check billing.', {
      detail,
      status,
    });
  }

  if (status >= 500) {
    return err('transport', 'Google Places API is temporarily unavailable. Try again shortly.', {
      detail,
      status,
    });
  }

  return err('internal', `Google Places API returned an unexpected error (HTTP ${status}).`, { detail, status });
}

export async function searchPlaces(
  req: SearchPlacesRequest,
  apiKey: string
): Promise<Result<SearchPlacesResponse>> {
  try {
    if (!apiKey || apiKey.trim().length === 0) {
      return err('config', 'No Google Places API key set. Add one in Settings.');
    }

    const limit = clampLimit(req.limit);
    const textQuery = buildTextQuery(req.category, req.city);

    const requestBody: PlacesSearchTextBody = { textQuery, pageSize: limit };
    if (req.pageToken !== undefined && req.pageToken.length > 0) {
      requestBody.pageToken = req.pageToken;
    }

    let response: Response;
    let rawText: string;
    try {
      response = await fetch(PLACES_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': PLACES_FIELD_MASK,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(15000),
      });
      rawText = await response.text();
    } catch (networkError) {
      return err('transport', 'Could not reach Google Places API (network error or timeout).', {
        detail: toDetail(networkError),
      });
    }

    let parsed: GoogleSearchTextResponseRaw;
    try {
      parsed = rawText.length > 0 ? (JSON.parse(rawText) as GoogleSearchTextResponseRaw) : {};
    } catch {
      return err('internal', 'Google Places API returned a response that could not be parsed.', {
        detail: rawText.slice(0, 200),
        status: response.status,
      });
    }

    if (!response.ok) {
      return mapHttpError(response.status, parsed.error);
    }

    const rawPlaces = Array.isArray(parsed.places) ? parsed.places : [];
    const candidates: Candidate[] = [];
    let skipped = 0;
    for (const place of rawPlaces) {
      const candidate = mapPlace(place);
      if (candidate === null) {
        skipped += 1;
      } else {
        candidates.push(candidate);
      }
    }
    if (skipped > 0) {
      console.warn(`[places] skipped ${skipped} place(s) missing id or display name`);
    }

    const nextPageToken =
      typeof parsed.nextPageToken === 'string' && parsed.nextPageToken.length > 0 ? parsed.nextPageToken : null;

    // Two strings, because they answer different questions and change at
    // different rates. quotaNote is per-scan counts and belongs in the results
    // band; quotaDetail is a static property of the field mask and belongs in
    // the footer, said once. Cramming both into the band turned a headline
    // into a debug log.
    const quotaNote =
      `1 request · ${candidates.length} result${candidates.length === 1 ? '' : 's'}` +
      (nextPageToken ? ' · more available' : '');

    const quotaDetail =
      `Billed at ${BILLED_SKU}, the highest tier present in the field mask (${BILLED_SKU_REASON}).` +
      (nextPageToken ? ' Each Load more is another billed request.' : '');

    return ok({
      candidates,
      nextPageToken,
      quotaNote,
      quotaDetail,
      query: { textQuery, city: req.city, category: req.category },
    });
  } catch (unexpected) {
    return err('internal', 'Unexpected error while searching Google Places.', {
      detail: toDetail(unexpected),
    });
  }
}
