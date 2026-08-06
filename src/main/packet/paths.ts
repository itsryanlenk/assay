/**
 * Where artifacts land, and what they are called.
 *
 * The rule it serves: open the folder, know
 * what you are looking at, without opening a file. Second: know its state
 * without opening a file, which is why state is a numbered folder rather than
 * a filename prefix. A prefix renamed on approval rewrites a path that may
 * already have been attached to a message.
 */

import * as path from 'node:path';

export type ArtifactKind =
  | 'AI-Readiness-Scan'
  | 'Scorecard'
  | 'Schema-Starter'
  | 'Social-Post'
  | 'Postcard-Front'
  | 'Postcard-Back';

/** Free-tier artifacts. Anything beyond these three is paid, and 00-INDEX says so. */
export const FREE_TIER: ArtifactKind[] = ['AI-Readiness-Scan', 'Scorecard', 'Schema-Starter'];

/** Strips punctuation and spaces to something safe for a folder name. */
function slugPart(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

/**
 * `<Town-ST>__<Business-Name>`, with a contact appended once known.
 *
 * Town leads because prospects cluster by geography, so an alphabetical
 * listing groups a scan run together.
 */
export function businessSlug(
  candidate: { name: string; address: string },
  contactName?: string | null
): string {
  const parts = candidate.address.split(',').map((p) => p.trim()).filter(Boolean);
  // Places formats as "street, town, ST zip, country". Town is third from the
  // end, and the state is the leading token of the second from the end.
  // A typed URL carries whatever town the operator entered instead: "Town, ST"
  // or "Town" alone.
  let town = '';
  let stateZip = '';
  if (parts.length >= 3) {
    town = parts[parts.length - 3] ?? '';
    stateZip = parts[parts.length - 2] ?? '';
  } else if (parts.length === 2) {
    town = parts[0] ?? '';
    // Only a real "ST" or "ST 12345" tail is a state. Taking the first token
    // unconditionally truncated whole place names: "Central, Hong Kong" became
    // Central-Hong and "Rockport, New Hampshire" became Rockport-New.
    stateZip = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(parts[1] ?? '') ? (parts[1] ?? '') : '';
    if (!stateZip) town = parts.join(' ');
  } else if (parts.length === 1) {
    town = parts[0] ?? '';
  }
  const state = stateZip.split(/\s+/)[0] ?? '';
  const place = [town, state].filter(Boolean).map(slugPart).join('-');

  const bits = [place || 'Unknown-Location', slugPart(candidate.name)];
  if (contactName) bits.push(slugPart(contactName));
  return bits.filter(Boolean).join('__');
}

/** Short business label used inside filenames. Distinct from the folder slug. */
export function businessShort(name: string): string {
  return slugPart(name).split('-').slice(0, 3).join('-') || 'Business';
}

export function isoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type PacketPaths = {
  root: string;
  index: string;
  evidence: string;
  drafts: string;
  approved: string;
  sent: string;
  rejected: string;
};

export function packetPaths(outputRoot: string, slug: string, date: string): PacketPaths {
  const root = path.join(outputRoot, 'clients', slug);
  return {
    root,
    index: path.join(root, '00-INDEX.md'),
    evidence: path.join(root, '01-evidence'),
    drafts: path.join(root, '02-drafts', date),
    approved: path.join(root, '03-approved', date),
    sent: path.join(root, '04-sent', date),
    rejected: path.join(root, '99-rejected', date),
  };
}

/** `<BusinessShort>__<Artifact>__<YYYY-MM-DD>.<ext>` */
export function artifactFilename(
  businessName: string,
  kind: ArtifactKind,
  date: string,
  ext: string
): string {
  return `${businessShort(businessName)}__${kind}__${date}.${ext}`;
}
