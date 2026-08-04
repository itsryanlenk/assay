# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it
reaches 1.0. It is pre-1.0; anything may change.

## [Unreleased]

The `0.1.0` line is the initial public release: the full local-first scanner and
packet workflow, hardened and audited, but not yet tagged.

### Added

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
- Business discovery via the Google Places API (New), constrained to a
  single discovery adapter.
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

### Security

- SSRF guard on `fetch-raw.ts` refusing Google Maps/Search hosts and private,
  loopback, link-local, and reserved addresses on every redirect hop.
- Preflight gate fails the build on any secret shape, absolute user path, or
  live email domain in a publishable file.
- Repository history scrubbed of a client business name before publication.
