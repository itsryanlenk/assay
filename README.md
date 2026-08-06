[![Assay: a local-first desktop tool that grades a business's own page source for AI readiness](.github/media/banner.png)](https://ryanlenk.com/pages/assay)

# Assay

![Assay running: candidate discovery on a map, then the two settings screens that put the operator's name, reply-to address and accent colour on the generated document](.github/media/assay-demo.gif)

Assay is a desktop tool for SEO, GEO and AEO consulting work. It reads the
machine-readable signals that AI crawlers and assistants rely on when they
answer a question about a local business, scores them, and turns the result
into a document the owner can act on.

## What you need to run it

Node 20 or newer, and no account of any kind. `.nvmrc` pins 20. Type a web
address on the scan screen and the six checks run and score it: no API key, no
billing, no sign-up. Both credentials below buy something extra, and neither
gates the engine.

Verified on Windows 11 with Node 22.14.0. The macOS and Linux code paths are
written and nobody has run them yet; if you try one, the result is worth an
issue either way.

- A Google Places API key, with Places API (New) enabled and billing active on
  the Google Cloud project. It buys area search: a city and a category, and a
  table of candidates you did not already know about, each carrying the listing
  fields the two cross-check checks compare against. Each search is one billed
  request at Text Search Enterprise rates, and each Load more is another.
- The `claude` CLI, installed and logged in. It buys the plain-English
  rewording of each verdict. Every score, severity, count and evidence hash is
  computed before a model is involved, so with no CLI on PATH the six checks
  still run and still produce a scored result. Each finding falls back to its
  deterministic sentence, which is blunter and equally true.

```
git clone https://github.com/itsryanlenk/assay
cd assay
npm ci
echo "# no operator terms on this machine" > .scrub-terms
npm test
npm start
```

That fourth line is what `npm test` needs, and it is the first thing that stops
a fresh clone. `npm start` runs without it.
`.scrub-terms` holds the client and operator names the publish gate
scans for. It is untracked on purpose, so it never travels with a clone, and
preflight refuses to run without it rather than report a pass for a scan that
checked nothing. Declaring an empty list is what the line above does.

On Windows PowerShell, write it with
`Set-Content -Encoding utf8 .scrub-terms '# no operator terms on this machine'`.
Redirection there can produce UTF-16, which preflight reads as garbage terms
and reports as leaks in files you have not touched.

`npm test` runs the app in a real window at stage two of eight. On a headless
Linux box that wants `xvfb-run npm test`, which is unverified like the rest of
Linux.

**It does not observe AI search.** Nothing here watches what an assistant says
about a business. It measures what that business publishes for one to read.

**The scoring instrument is calibrated against two delivered client scans,
which between them publish three scored properties, and nothing else.** That is
a small set. `scripts/test-instrument.js` fails `npm test` if the instrument
stops reproducing those three scores. Limitations, near the bottom, covers both
at length.

It is built for one person doing outreach by hand, and it automates the process
that person already runs:

1. **Find a business,** two ways. Search an area through the Google Places API,
   one area at a time, and results list as a table with a **MAP** toggle that
   plots the ones carrying coordinates. The map costs no extra API: those
   coordinates arrive with the search you already paid for. Or type the address
   of a business you already know, which needs no key and no billing and puts
   one row in the same table.
2. **Score what the site actually serves.** Six checks fetch the business's own
   pages and score the raw source. A summary of a page is never evidence here.
3. **Reconcile the findings yourself.** You open the page in your own browser,
   copy the view-source, paste it back, and the check is recomputed from your
   paste. A finding you do not reconcile stays unconfirmed and cannot reach a
   document. Two exceptions. The AI-readiness score reconciles by severity band
   rather than by exact number, and the widest band is twenty-five points, so a
   thinner re-score landing in the same band confirms the figure the app
   fetched. And where a finding compares the site against the Google listing,
   only the site half is reconciled; the listing half is the app's own capture
   on both passes.
4. **Generate the packet.** A PDF scorecard, a schema starter kit, and delivery
   drafts.
5. **Approve each artifact on its own.** Nothing auto-sends. There is no sender
   implementation in this codebase: `src/main/send/provider.ts` defines the
   outbound signature and nothing implements it. Once a prospect is dealt with,
   **ARCHIVE** files its decided artifacts out of the queue. The ledger is
   untouched, RESTORE brings them back, anything still waiting on you is never
   filed away, and new work for that prospect un-files it.

Step three is why the rest exists. You tell a prospect that every finding in the
document points at something they can see in their own source with Ctrl+U, and a
tool that let an unreconciled finding through would make that worthless. Where a
finding compares that source against their Google listing, the listing side is
the app's capture rather than theirs. Say so when you hand the document over.

Generation records everything it writes as **prepared**, which is not approved.
A finished branded document sitting in a folder already looks done, and the only
thing between it and a prospect is memory.

## Making the work look like yours

Three optional settings, none of which can change a finding.

- Brand voice. Instructions in Settings for the model that rewords findings
  into owner-facing sentences. It steers tone and word choice, and it sits
  below the rules the model may not break, so it cannot add a fact, a number or
  a consequence. Every sentence still passes the headline validator, and one
  that invents a figure the checks did not measure refuses to generate.
- An accent colour. Six-digit hex. It replaces the highlight on the
  scorecard, and the app picks black or white text against it by measured
  contrast. Severity shading stays on the house scale, so a serious finding
  still reads as serious in anyone's colours.
- A logo. PNG or JPEG under 512KB. Assay keeps its own copy in
  `data/brand/`, so moving the original later does not break your documents.

Regenerating an artifact you already approved changes its bytes, so the
approval gate flags it and refuses the stale token. It is the same wall that
stops approve-edit-send. Re-approve and it clears.

**What the model is allowed to do.** Scores and severities are computed by
code, from three inputs: the raw source, the Google Places listing fields
(name, phone, address, primary type), and the date the check ran. Five of the six checks
then ask a model to reword the verdict the code already reached into a sentence
a business owner would understand, and that reworded sentence is what prints on
the document. The model cannot change a severity, a count, a piece of evidence
or a fix. It gets no fetch tool, no browser and no search, and everything it
writes is validated by `src/main/checks/headline.ts` before it can reach a
document.

---

## The five laws

These are not comments. Each has a named enforcement point, so a change that
breaks a law breaks a test or a type rather than a convention.

| # | Law | Enforced by |
|---|---|---|
| 1 | AI-summarized page content is never evidence. Raw source only. | `src/main/evidence/fetch-raw.ts` is the only network egress for target sites. Two places mint an `EvidenceRef`: `fetch-raw.ts` for what the app fetched, and `src/main/confirmation/gate.ts` for the view-source the operator pasted, which is the most directly witnessed evidence in the system. Agents get no fetch tool, no browser and no search. |
| 2 | Never fabricate a review, testimonial or result. | `src/main/packet/guardrails.ts`, swept over every artifact and over the index prose before anything is written. It refuses rather than repairs. |
| 3 | Nothing auto-sends, auto-posts or auto-prints. Approval is per item. | `src/main/approval/gate.ts` registers every `ApprovedItem` in a module-private `WeakSet` at the moment it is minted, so `assertMinted` refuses anything that did not come through the approval gate, including a cast. The `unique symbol` on the type is a compile-time brand and is erased at build; the runtime guarantee is the set. The gate calls the same `releasable()` that generation calls, so the two cannot disagree, and it refuses an artifact whose bytes changed after approval or one a later scan has superseded. There is deliberately **no unapprove**; a rejection can be reopened, which returns the item to `prepared` rather than clearing it to send. Today no sender implementation exists either: `src/main/send/provider.ts` defines the outbound signature and nothing implements it. |
| 4 | Every score prints its instrument and its base. | The `Score` type has no optional fields, so omitting the base is a compile error. |
| 5 | Discovery is the Places API, an address you type, and the business's own site. | Two entry points and one egress. `src/main/discovery/places.ts` calls Places; `src/main/discovery/from-url.ts` takes an address you type and mints no listing data. Both reach the site through `fetch-raw`, which refuses Google Maps and Search hosts, and private or loopback addresses, on every redirect hop. `from-url` applies that same list at the form, so a Maps URL is refused before anything is fetched. |

Model output is used for exactly one thing: rewording a verdict the
deterministic layer already computed into a sentence an owner would understand.
It cannot change a severity, a count, an evidence hash or a fix. Everything it
writes is validated by `src/main/checks/headline.ts` before it can reach a
document.

---

## Setup

Node 20 or newer, on Windows. See [What you need to run it](#what-you-need-to-run-it)
for the Places key, the optional `claude` CLI, and the one line a fresh clone
needs before `npm test` will run.

```bash
npm install
```

```bash
npm start
```

### Where it puts things

Everything the app writes goes to **one folder next to the install**, `data/`,
which is gitignored. PDF rendering is the one exception: it writes a temporary
HTML file to the system temp folder and removes it after the print. The folder
carries a generated `README.md` explaining itself, so it does not need this one.

```
data/
  README.md            what each entry below is
  config.json          API keys and operator identity; the only file you edit
  approvals.json       the approval ledger
  clients/             the work, one folder per business
  captures/            raw fetched pages, a cache
  blocklist.json       businesses never to contact again
  packet-starts.json   first-contact dates, for pacing
  tiles/               map tiles cached from OpenStreetMap, safe to delete
  brand/               your logo, if you set one in Settings
  .chromium/           Electron's profile. Not ours, safe to delete
```

Set `ASSAY_DATA_DIR` to put it elsewhere. If the install directory is not
writable, which is normal for a machine-wide install under Program Files, it
falls back to the platform's app-data location and says so on the first line of
the startup log.

Earlier builds used `%APPDATA%/assay` and mixed the operator's keys and
client packets in with thirteen Chromium profile files. On first start the app
copies its own files forward, never overwriting, and moves anything superseded
into `data/.superseded/` rather than deleting it. Check it once, then remove it.

Keys are entered in the app's Settings view and stored in `config.json`, written
with a write-then-rename and mode `0600`. That mode is owner-only on macOS and
Linux; on Windows it is close to a no-op, so there the key's confidentiality
rests on the ACL of your user profile, where the data root lives, rather than on
the file mode. The one stored secret is a low-value Places key. Nothing secret
belongs in this repo; `.env.example` documents the variable names only, and
environment variables are read as a read-only fallback.

| Key | Needed for | Notes |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | business discovery | Needs **Places API (New)**, not the legacy Places API, with billing active. The only key this build reads. |

**There is deliberately no Anthropic, Lob or PostGrid key field.** The Agent SDK
path is not built, so `auto` mode always uses the `claude` CLI, and no sender
exists in this build. Settings shows those fields as not wired and the app
refuses to store them. A stored secret with no consumer is a liability with no
upside.

The agent path shells out to the `claude` CLI so the work draws on a Pro/Max
plan rather than metered API spend. Run `claude login` once. Without it the app
still runs and produces blunter headlines; it cannot change a finding.

## Tests

```bash
npm test
```

Two gates and six suites:

- preflight scans every file git would publish for key shapes, absolute
  user paths and live email domains, and fails the build rather than warning.
- smoke boots the real Electron window, fails on console errors, CSP
  violations or preload faults, and drives the nav rather than asserting the
  markup exists. Losing the single-instance lock is a failure here, not a
  quiet exit, because a gate that cannot tell "passed" from "never ran" is not
  a gate.
- IPC drives the channels through the real preload bridge, with payloads
  and with its refusals, and drives the approvals UI through real clicks.
- parsers, instrument calibration, confirmation gate, packet generation and
  approval queue cover the engine. The calibration suite
  fails `npm test` if the instrument stops reproducing the three published
  scores, and it pins the agent CLI lockout flags.

`npm run typecheck` runs `tsc --noEmit`. `npm run preview` renders the UI to a
PNG without spending a Places request.

---

## Limitations

- There is no sender. `send/provider.ts` defines the outbound
  signature with no implementation. Any sender must call `assertMinted` first.
- Opening the map talks to OpenStreetMap. The scan view can plot results
  on a street map. Tiles come from `tile.openstreetmap.org`, fetched by the
  main process through a validating proxy and cached under `data/tiles/`;
  the renderer itself still makes no network requests, and no tile is
  fetched until you open the map.
- The AI-readiness instrument is calibrated against two delivered client
  scans, which between them publish three scored properties, and nothing
  else. That is a small calibration set. `scripts/test-instrument.js`
  fails `npm test` if the instrument stops reproducing those three scores.
- Page discovery is best-effort. The sitemap named in robots.txt is read
  first, then the conventional path, then same-origin links from the homepage.
  A site that hides its pages behind JavaScript will still be read as one page,
  and the score is refused rather than guessed when that happens.
- Confirming a multi-page site takes one paste per page. Site-wide items
  (entity schema, FAQ) are scored across the pages the crawler discovered, so the
  confirmation UI offers a paste slot for each page it read, alongside the
  homepage, robots.txt, llms.txt and sitemap.xml. Paste them and the site-wide
  score is reproduced from your own source and confirms; leave a page the score
  rests on blank and the finding stays **unconfirmed** with a note to paste it,
  never mislabelled as the site answering crawlers differently than browsers.
  It is more manual than a single-page confirmation.
- The llms.txt coverage band is a judgement call. It is implemented as
  "every real page in the sitemap also appears in llms.txt", which is computable
  but is not exactly what the published rubric meant. The expectation excludes
  the taxonomy and archive URLs a CMS lists in its sitemap: category, tag and
  author archives, dated post archives, pagination and feeds. An llms.txt
  should not carry them, and docking a business for their absence was noise in
  a client document.
- The renderers are template-shaped. The social post and postcard read
  acceptably but come from templates.
- Confirmations do not survive a restart, on purpose. They expire 72 hours
  after they are made, so persisting one would let a stale confirmation look
  live. The cost is that an artifact prepared in an earlier session has to be
  re-confirmed before it can be approved.

## Contributing and security

- Contributing: the bar and the workflow are in [CONTRIBUTING.md](CONTRIBUTING.md).
  Short version: the five laws are enforced by tests and types, tests come before
  implementation, and nothing under `data/` or any secret reaches a tracked file.
- Security: the threat model, the reporting channel, and the known accepted
  limitations are in [SECURITY.md](SECURITY.md). Report a vulnerability privately
  through the repository's Security tab, never a public issue.
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Changes: [CHANGELOG.md](CHANGELOG.md).

## Maintainer

Assay is built and maintained by [Ryan Lenk](https://ryanlenk.com).

## Licence

MIT, see [LICENSE](LICENSE). The three font dependencies are OFL-1.1 and
Leaflet is BSD-2-Clause; none of them are vendored into this repository (the
build copies them out of npm packages), and the LICENSE file explains what that means if
you package the app for distribution.
