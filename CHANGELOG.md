# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it
reaches 1.0. It is pre-1.0; anything may change.

## [Unreleased]

The `0.1.0` line is the initial public release: the full local-first scanner and
packet workflow, hardened and audited, but not yet tagged.

### Added

- The scorecard's closing ask is the operator's choice: the house pitch, their
  own words, or nothing at all, in which case the page closes with the
  signature. Operator prose bound for a client document takes no digits and no
  invisible characters, because a figure belongs to a finding the reader can
  reproduce.
- Your brand on the work. A brand voice steers how findings are worded,
  fenced below the rules the model may not break. An accent colour and a logo
  brand the scorecard; severity shading stays on the house scale so a serious
  finding still reads as one. The logo is copied into the data root and
  referenced by kind, never by a stored path.
- A map picker on the scan view, plotting results already fetched. Tiles are
  fetched by the main process through a validating, host-pinned proxy and cached
  under `data/tiles/`; the renderer still makes no network requests of its own.
- An approvals archive. Decided work can be filed away per prospect, with
  waiting items exempt from archiving and any new activity restoring them.
- Two ways to put a business in front of the checks. Area search calls the
  Google Places API (New) through a single adapter. Typing a web address needs
  no key, no billing and no account, and the six checks run and score from it,
  so the scoring engine is reachable without signing up for anything. A typed
  candidate carries no listing, and its provenance is what enforces that, not
  whether a field happens to be empty: the checks that compare a site against
  its listing record that they had nothing to compare and cannot report a
  mismatch, and the schema starter kit credits the operator for those facts
  instead of a Google Business Profile.
- Six deterministic checks run in parallel against a business's own page
  source: website presence, crawl/index health, AI-readiness, freshness,
  booking path, and NAP consistency. Ranking takes the worst single finding, not
  an average.
- Evidence-first scoring. The only network egress to a target site is
  `fetch-raw.ts`, which mints the evidence reference for everything the app
  fetches. Every score prints its instrument and its base.
- A confirmation gate. No artifact is generated from a finding until the
  operator confirms it against their own browser's view-source. Confirmations
  expire after 72 hours and do not survive a restart, on purpose.
- The packet: a PDF scorecard, a schema starter kit, a plain-words
  summary, a social draft, and a postcard draft, plus a populated evidence
  folder carrying the captures each claim cites.
- A per-item approval gate (Law 3). Generation records everything as
  *prepared*; approval mints an unforgeable per-artifact token and refuses an
  artifact whose bytes changed after approval or that a later scan superseded.
  There is no auto-send and no unapprove.
- Guardrails swept over every artifact and the index prose before anything
  is written: no fabricated review, testimonial, or result; the sweep refuses
  rather than repairs.
- One data folder next to the install holding all runtime state, with a
  generated README, `0600` config writes, and a non-destructive migration from
  the earlier `%APPDATA%` layout.
- Two build gates (preflight leak scan, Electron smoke boot) and six test
  suites: IPC integration, parsers, instrument calibration, confirmation gate,
  packet generation, and the approval queue.

### Fixed

- The approval ledger keys a row to the prospect rather than to the folder
  slug. The slug is built from the business name, the town and the contact
  name, so changing any of them left every earlier row outside the supersede
  sweep: an approved artifact stayed approved and stayed sendable while a
  newer scan of the same business existed.
- A phone number carrying an extension no longer reads as a different number.
  The extension survived the last-ten-digits comparison and dropped area-code
  digits instead, which named a business's own correct number as wrong at the
  top severity.
- A packet that proves a phone or address mismatch no longer pastes the
  disputed value into the markup the owner is told to publish.
- The scorecard carries its header on every page, and no block, band, finding
  or rubric row is split across a page break.

### Security

- SSRF guard on `fetch-raw.ts` refusing Google Maps/Search hosts and private,
  loopback, link-local, and reserved addresses on every redirect hop. Maps is
  matched on a label boundary with the trailing dot normalised, so neither
  `www.maps.google.com` nor `maps.google.com.` reaches a fetch.
- Credentials in a typed web address are refused rather than carried into the
  evidence manifest a prospect receives.
- Commit messages are scanned for leaks alongside trees, and a pre-push hook
  scans exactly the commits a push would publish.
- Any tracked file that is not known text and not named in `.binary-allow` is
  refused, because every other leak scan reads text and an image can carry a
  business name in its pixels or its metadata.
- The build fails when a business the app has scanned is not covered by the
  operator's scrub-term list.
- Preflight gate fails the build on any secret shape, absolute user path, or
  live email domain in a publishable file.
- Repository history scrubbed of a client business name before publication.
