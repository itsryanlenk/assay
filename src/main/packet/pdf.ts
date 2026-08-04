/**
 * HTML to PDF, for the artifacts a prospect actually receives.
 *
 * WHY THIS EXISTS. The scorecard was written to disk as an .html file. That is
 * fine as a rendering target and wrong as a deliverable: it opens differently
 * in every browser, it is trivially editable after approval, and emailing
 * somebody a loose .html attachment reads as suspicious rather than as a
 * document. A PDF is one file that looks the same everywhere.
 *
 * WHY IT IS NOT IN generate.ts. `printToPDF` is Electron, and packet
 * generation is deliberately plain Node so `npm run test:packet` can exercise
 * both of its walls without booting a browser. Generation takes this as an
 * injected function instead, so the walls stay testable and the renderer stays
 * a pure string function.
 *
 * "CLEAN EVERY TIME" IS THE HARD PART, and it is three separate problems:
 *
 * 1. FONTS. The standalone HTML carries no @font-face, so it renders in
 *    whatever the machine happens to have and the brand typography is gone.
 *    The woff2 files are embedded here as data URIs, so the PDF carries its
 *    own fonts and looks identical on a machine that has never seen them.
 *
 * 2. TIMING. Printing before the fonts finish decoding produces a document
 *    set in the fallback face, or occasionally a blank one. `document.fonts.ready`
 *    is awaited before printing rather than sleeping and hoping.
 *
 * 3. LAYOUT. The scorecard is a 1200px screen sheet. Printed as-is it is
 *    clipped or shrunk to illegibility, and rows split across page breaks. The
 *    injected print stylesheet makes the sheet fluid, keeps blocks and tables
 *    whole across pages, and drops the page margin to zero so the cream field
 *    reaches the paper edge instead of floating in a white border.
 */

import { BrowserWindow, session } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One process-lifetime session for every render, not one per call.
 *
 * Electron caches Session objects by partition name and exposes no API to
 * release them, so a uniquely-named session per render leaks one Session for
 * the life of the process. A single stable in-memory partition reuses exactly
 * one. Safe because renders are sequential (packets generate one at a time);
 * the per-call onBeforeRequest listener is re-registered on each render and
 * Electron keeps only the latest, so each render's temp-file allowlist wins.
 */
const PDF_PARTITION = 'pdf-render';

/** The exact faces the house theme names. Same list as scripts/copy-assets.js. */
const FONT_FACES: { family: string; weight: number; file: string }[] = [
  { family: 'Archivo Black', weight: 400, file: 'archivo-black-latin-400-normal.woff2' },
  { family: 'Inter', weight: 400, file: 'inter-latin-400-normal.woff2' },
  { family: 'Inter', weight: 700, file: 'inter-latin-700-normal.woff2' },
  { family: 'JetBrains Mono', weight: 400, file: 'jetbrains-mono-latin-400-normal.woff2' },
  { family: 'JetBrains Mono', weight: 700, file: 'jetbrains-mono-latin-700-normal.woff2' },
];

/**
 * Embedded rather than linked. A PDF that depends on the reading machine
 * having Archivo Black installed is not a deliverable.
 *
 * Missing files are skipped, not fatal: a PDF in fallback type is worth more
 * than a refusal, and `npm run build:assets` is what puts them there.
 */
export function fontFaceCss(fontsDir: string): string {
  const rules: string[] = [];
  for (const f of FONT_FACES) {
    const file = path.join(fontsDir, f.file);
    if (!fs.existsSync(file)) continue;
    const b64 = fs.readFileSync(file).toString('base64');
    rules.push(
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
    );
  }
  return rules.join('\n');
}

/**
 * Print rules for a sheet that was designed for a 1200px browser window.
 *
 * `margin: 0` with padding on the sheet, so the cream field runs to the paper
 * edge. Chromium does not paint a background into the @page margin, so a
 * non-zero margin would frame a designed document in white.
 */
const PRINT_CSS = `
@page { size: Letter portrait; margin: 0; }
html, body {
  background: #F1EEE3 !important;
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}
.sheet-1200 { width: 100% !important; max-width: 100% !important; padding: 13mm !important; }
/* .ask was missing here, so the closing block split across the page break and
   left "you already have both numbers:" hanging with its two bullets on the
   next sheet. It is the block that carries the operator's name and the ask,
   so it is the last one that should be allowed to break. */
.block, .ask, table.matrix, .band, .scoreband, .stamp, .footer, tr { break-inside: avoid; page-break-inside: avoid; }
h1, h2, .band { break-after: avoid; page-break-after: avoid; }
`;

/** Injects our rules as the LAST styles in head, so they win on equal specificity. */
export function withPrintStyles(html: string, fontsDir: string): string {
  const injected = `<style>\n${fontFaceCss(fontsDir)}\n${PRINT_CSS}\n</style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${injected}\n</head>`)
    : `${injected}\n${html}`;
}

export class PdfRenderError extends Error {
  constructor(message: string) {
    super(`Could not render the PDF: ${message}`);
    this.name = 'PdfRenderError';
  }
}

/**
 * Renders one self-contained HTML document to PDF bytes.
 *
 * The window is throwaway, hidden, sandboxed, has no preload and no Node, and
 * runs in its own session whose every network request is cancelled. The
 * document contains third-party strings (the prospect's business name, their
 * page title), and although the renderer escapes them and the guardrail sweep
 * has already run, a printing surface that cannot reach the network is one
 * less thing resting on that being perfect.
 */
export async function htmlToPdf(
  html: string,
  opts: { fontsDir: string; timeoutMs?: number }
): Promise<Buffer> {
  /**
   * A temp file, not a data: URL.
   *
   * The first version navigated to `data:text/html,...`. With five woff2 faces
   * embedded the document is several hundred kilobytes, and a load at that
   * size was observed failing with ERR_FAILED while an identical smaller one
   * succeeded. "Clean every time" cannot rest on a navigation that gets
   * size-sensitive as the report grows, so the document goes to disk and is
   * removed in the finally.
   */
  const tmp = path.join(
    os.tmpdir(),
    `assay-pdf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
  );

  const ses = session.fromPartition(PDF_PARTITION);
  // Re-registered every render because the temp path changes; Electron keeps
  // only the latest listener, so the shared session still cancels everything
  // except the one file we just wrote. The document is self-contained by
  // construction; if that ever stops being true it fails loudly here rather
  // than fetching from a prospect's server while we render their PDF.
  //
  // What this listener does and does not cover, stated precisely because
  // images are now enabled below: it bounds NETWORK loads. data: URIs never
  // reach webRequest at all, since they are not network loads, so the
  // startsWith('data:') branch is belt-and-braces rather than the guard.
  // What bounds an <img> is that no third-party string can reach a markup
  // position: every renderer escapes, all CSS is static, and the only image
  // any renderer emits is the operator's own logo, embedded as data: by
  // main after sniffing its bytes.
  const allowed = pathToFileURL(tmp).href;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: !(url === allowed || url.startsWith('data:')) });
  });

  const win = new BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Enabled for the operator's logo, which arrives as a data: URI in the
      // document itself. Network image loads are cancelled by the listener
      // above, so enabling this widens what can DRAW, not what can be
      // FETCHED. Pinned by a test that serves a live http:// image and
      // asserts the listener never sees a request.
      images: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Every outbound wait in this app is bounded (fetch-raw aborts, the CLI kills
  // on a timer). A render is no different: if the load stalls or the embedded
  // faces never settle document.fonts.ready, packet:generate would await here
  // forever. Race the whole render against a deadline; the finally below tears
  // the window down whichever side wins.
  const timeoutMs = opts.timeoutMs ?? 30000;

  try {
    fs.writeFileSync(tmp, withPrintStyles(html, opts.fontsDir), 'utf8');

    const render = (async () => {
      await win.loadFile(tmp);

      // Wait for the embedded faces to decode. Printing before this yields a
      // document in the fallback face, which is the failure this whole module
      // exists to avoid, and it is a race rather than a consistent bug.
      await win.webContents.executeJavaScript(
        'document.fonts.ready.then(() => document.fonts.status)'
      );

      return win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        pageSize: 'Letter',
        landscape: false,
        margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
      });
    })();
    // If the deadline wins, render still settles later against a window the
    // finally has destroyed; absorb that so it never surfaces as an unhandled
    // rejection.
    render.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PdfRenderError(`PDF render timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    let pdf: Buffer;
    try {
      pdf = await Promise.race([render, deadline]);
    } finally {
      clearTimeout(timer);
    }

    if (pdf.length === 0 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new PdfRenderError('the printer returned something that is not a PDF');
    }
    return pdf;
  } catch (e) {
    if (e instanceof PdfRenderError) throw e;
    throw new PdfRenderError((e as Error).message);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort: a stray temp file is not worth failing a generation over */
    }
  }
}
