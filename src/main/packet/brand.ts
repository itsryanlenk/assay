/**
 * The operator's visual brand on generated documents: an accent colour and a
 * logo. Deliberately not a theming system. The house design system stays the
 * design; the operator recolours its emphasis surfaces and signs the page.
 *
 * TWO THINGS THIS MODULE REFUSES TO DO, both from the design review:
 *
 * 1. Severity shading is NOT brand. The scorecard shades severity 2 and 3
 *    finding blocks with the same yellow it uses for emphasis. Recolouring
 *    those would render a sev-2 block in a client's navy while its badge
 *    stayed on the house cell scale, destroying the severity encoding. Only
 *    emphasis surfaces take the accent; findingBlock and every badge keep
 *    the house colours.
 *
 * 2. It never trusts a stored path. Config stores an extension marker, and
 *    the file is resolved from the data root at generate time, so a
 *    hand-edited config.json cannot point the renderer at an arbitrary file
 *    and have its bytes embedded in a client deliverable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogoKind = '' | 'png' | 'jpg';

/** What a renderer receives. Null when the operator set no brand at all. */
export type BrandContext = {
  /** Accent as a background, for emphasis surfaces. */
  accentBg: string;
  /** Ink or paper, whichever reads against accentBg. */
  accentBgText: string;
  /** Accent as text/rules ON ink, or paper when the accent cannot carry it. */
  accentOnInk: string;
  /** data: URI, or '' when no logo is set or the file no longer verifies. */
  logoDataUri: string;
};

export const HOUSE_ACCENT = '#F5D90A';
export const INK = '#111111';
export const PAPER = '#FFFFFF';

/** Strict. Anything else is refused rather than repaired. */
export const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 512KB on disk, plus a pixel budget read from the file HEADER.
 *
 * The pixel budget is the one that matters: a 500KB PNG can declare
 * 20000x20000, and anything that learns its size by decoding has already
 * allocated 1.6GB to find out. Dimensions come from the IHDR or the SOF
 * marker instead, so the refusal happens before any decoder sees the bytes,
 * and it is re-checked at embed time rather than trusted from intake.
 */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_DIMENSION = 4000;
export const LOGO_MAX_PIXELS = 4000 * 4000;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Width and height straight out of the file header, without decoding.
 * Null when the header cannot be read, which is itself a refusal.
 */
export function imageDimensions(buf: Buffer, kind: LogoKind): { w: number; h: number } | null {
  try {
    if (kind === 'png') {
      // 8-byte signature, 4-byte length, 'IHDR', then width and height.
      if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (kind === 'jpg') {
      /**
       * Walks segments the way the spec defines them, which matters: an
       * earlier version treated EVERY marker as length-prefixed, so a
       * standalone marker (TEM, RST0-7, SOI, EOI) made it read the next
       * marker's bytes as a length and jump to an attacker-chosen offset.
       * A planted fake SOF there reported 100x100 for a 30000x30000 image,
       * defeating the gate that exists to refuse exactly that. Found by the
       * pre-merge security review, with a working file.
       */
      let i = 2;
      while (i + 1 < buf.length) {
        // Fill bytes: any number of 0xFF may precede a marker.
        if (buf[i] !== 0xff) return null;
        while (i < buf.length && buf[i] === 0xff) i++;
        if (i >= buf.length) return null;
        const marker = buf[i] as number;
        i++;

        /**
         * FF 00 is a stuffed zero inside entropy-coded data, not a marker.
         * Treating it as length-prefixed reads the following bytes as a
         * segment length and jumps to an attacker-chosen offset: the same
         * desync the standalone-marker fix closed, through another door, and
         * it defeated both the intake gate and the embed-time re-check. A
         * real decoder produced 6000x6000 while this reported 64x64. Found
         * by the pre-merge verification pass, with a file.
         */
        if (marker === 0x00) return null;
        // Standalone markers carry no length field.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
        // Entropy-coded data begins at SOS; no header follows to read.
        if (marker === 0xda) return null;

        if (i + 1 >= buf.length) return null;
        const segLen = buf.readUInt16BE(i);
        if (segLen < 2 || i + segLen > buf.length) return null;
        // A frame header needs 8 bytes; a shorter one would read its size
        // from outside its own segment, so it is refused rather than read.
        if (marker >= 0xc0 && marker <= 0xcf && segLen < 8) return null;

        // SOF0..SOF15 carry the frame size; C4/C8/CC are other tables.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (i + 7 > buf.length) return null;
          // Same key order as the PNG branch: height precedes width in the
          // JPEG frame header, but the shape this function returns should not
          // depend on which format it read.
          return { w: buf.readUInt16BE(i + 5), h: buf.readUInt16BE(i + 3) };
        }
        i += segLen;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** True when the header declares a picture this app is willing to draw. */
export function dimensionsAcceptable(buf: Buffer, kind: LogoKind): boolean {
  const d = imageDimensions(buf, kind);
  if (!d) return false;
  if (d.w <= 0 || d.h <= 0) return false;
  if (d.w > LOGO_MAX_DIMENSION || d.h > LOGO_MAX_DIMENSION) return false;
  return d.w * d.h <= LOGO_MAX_PIXELS;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Derives the two treatments a document needs from one accent.
 *
 * No tuned luminance threshold: each slot picks by measured contrast, so
 * there is no magic constant for a later change to get wrong.
 *
 * The floor, stated because "always readable" would overstate it: for any
 * colour x, contrast(x,ink) * contrast(x,paper) is the constant
 * contrast(paper,ink) = 18.8831, so the better of the two can never fall
 * below its square root, 4.3455. That is under AA 4.5 for the 12.5px body
 * text on an accent background, so a worst-case accent (a few mid reds and
 * olives) lands just short. Accepted for v1, and the identity is pinned in
 * the tests rather than the number being asserted against one sample.
 *
 * Fails closed rather than open: an accent that is not exactly #rrggbb
 * yields NaN comparisons, which would return the raw string into a CSS
 * position, so it is refused here as well as by every caller.
 */
export function deriveTreatments(accent: string): Omit<BrandContext, 'logoDataUri'> {
  if (!ACCENT_RE.test(accent)) accent = HOUSE_ACCENT;
  const bgText = contrast(accent, INK) >= contrast(accent, PAPER) ? INK : PAPER;
  // The smallest consumer of accent-on-ink is 10px mono, so normal-text AA
  // governs; an accent that cannot carry it hands the slot to paper.
  const onInk = contrast(accent, INK) >= 4.5 ? accent : PAPER;
  return { accentBg: accent, accentBgText: bgText, accentOnInk: onInk };
}

/** PNG and JPEG magic bytes. SVG is refused right here: it is markup. */
export function sniffImage(buf: Buffer): LogoKind {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return '';
}

export function logoFilePath(brandDir: string, kind: LogoKind): string {
  return path.join(brandDir, `logo.${kind}`);
}

/**
 * Reads the app's own copy and re-verifies it before embedding. A logo that
 * no longer verifies costs the logo, never the packet: branding must not be
 * able to block a deliverable.
 */
export function logoDataUriFrom(brandDir: string, kind: LogoKind): string {
  if (kind !== 'png' && kind !== 'jpg') return '';
  try {
    const file = logoFilePath(brandDir, kind);
    // Read first, then judge the bytes in hand. Stat-then-read would be
    // checking a file that can be swapped between the two calls.
    const buf = fs.readFileSync(file);
    if (buf.length > LOGO_MAX_BYTES) return '';
    // MIME comes from the bytes, never from the name on disk.
    const sniffed = sniffImage(buf);
    if (sniffed !== kind) return '';
    // Re-checked here, not trusted from intake: the copy in the data root can
    // be replaced by anything with write access to that folder.
    if (!dimensionsAcceptable(buf, sniffed)) return '';
    const mime = sniffed === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** Null when nothing is branded, so renderers can skip the whole block. */
export function brandContext(
  brand: { accent: string; logo: LogoKind },
  brandDir: string
): BrandContext | null {
  const accent = ACCENT_RE.test(brand.accent) ? brand.accent : '';
  const logoDataUri = logoDataUriFrom(brandDir, brand.logo);
  if (accent === '' && logoDataUri === '') return null;
  return { ...deriveTreatments(accent === '' ? HOUSE_ACCENT : accent), logoDataUri };
}

export const __test = { luminance, contrast, deriveTreatments, sniffImage, imageDimensions, dimensionsAcceptable };
