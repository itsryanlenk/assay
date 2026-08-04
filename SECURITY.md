# Security Policy

Assay is a **local-first desktop application for a single operator**. It
runs on your own machine, writes everything to one folder next to the install,
and talks to four kinds of remote host: the Google Places API; the public web
pages of the businesses you scan; once the operator has logged in the
`claude` CLI, Anthropic's API, which the headline-rewording step reaches
through that CLI carrying the verdict text the code already computed; and,
only after the operator opens the map, `tile.openstreetmap.org`, which the
main-process tile proxy fetches street tiles from. The tile server learns the
operator's IP and the tile coordinates, which approximate the searched area;
the search area was already sent to Google to produce the results, and no
business identity appears in a tile URL. The app itself has no account system
and sends no telemetry of its own. Today there is also no server and no outbound sender:
`src/main/send/provider.ts` defines the outbound signature and nothing
implements it. The [roadmap](ROADMAP.md) commits to both, under conditions
that this file will hold them to: a sender takes exactly one artifact per
explicit human action and calls `assertMinted` first, and any local listener
ships with an auth token, refuses cross-origin callers, and never exposes the
approval or send channels. Until those land, the threat model is one local
process: a bug here compromises the operator running it.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through GitHub's built-in flow:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** (this opens a private security advisory).
3. Describe the issue, the affected file(s), and a reproduction if you have one.

If private advisories are unavailable to you for any reason, open a regular
issue that says only *"security issue, please enable private reporting"*, with
no details, and the maintainer will open a private channel.

What to expect:

- An acknowledgement within **7 days**.
- An initial assessment (accepted / needs-info / out-of-scope) within **14 days**.
- For accepted reports, a fix or a documented mitigation, and credit in the
  release notes if you want it.

This is a solo-maintained project, so timelines are best-effort.

## Supported versions

The project is pre-1.0 and ships from `main`. Only the latest commit on
`main` is supported. There are no backported security fixes to older tags.

| Version | Supported |
|---|---|
| `main` (latest) | yes |
| any earlier tag/commit | no |

## What is in scope

- SSRF / network egress. `src/main/evidence/fetch-raw.ts` is the only path
  that fetches a target site. It refuses Google Maps/Search hosts and private,
  loopback, link-local and reserved addresses on every redirect hop, and it pins
  the validated address at connect time (a custom dispatcher lookup), so a
  hostname cannot resolve public to the check and private to the socket. A way to
  make it reach an internal address, a cloud metadata endpoint, or a disallowed
  host is in scope. The map tile proxy (`src/main/tiles/proxy.ts`) is
  fixed-host by construction and validates every coordinate; a way to make it
  fetch from anywhere but `tile.openstreetmap.org`, or to reach the filesystem
  through it, is equally in scope.
- Electron process boundary. Context isolation, the preload bridge in
  `src/main/preload.ts`, the IPC channel allow-list in `src/shared/channels.ts`,
  and the renderer CSP. A renderer-to-main escape, an unvalidated IPC payload
  that writes outside the data root, or a navigation/`openExternal` that a
  hostile page can drive is in scope.
- The five laws. The design promises in the README are enforced in code
  (evidence provenance, no fabrication, per-item approval, score transparency,
  discovery surface). A way to make an artifact ship a claim the operator never
  confirmed, or to bypass `assertMinted`, is in scope.
- Secret handling. `data/config.json` holds the operator's Places key. A way
  to leak it into a packet, a log line, an error message, or a fetched-site
  request is in scope.
- Injection into deliverables. Hostile content on a scanned site reaching
  the generated PDF/Markdown packet as executable markup or a live link is in
  scope.

## Known and accepted limitations

These are documented, understood, and accepted for a single-operator desktop
tool. They are **not** what to report. A way to *exploit* one beyond its
stated bound is.

- No auto-update. There is no update channel, so there is no update channel
  to compromise, and equally no automatic delivery of a security fix. Pull and
  rebuild.
- Bundled fonts and Leaflet under a packaged build. The source repo
  vendors neither; a packaged artifact embeds OFL-1.1 fonts and BSD-2-Clause
  Leaflet and carries their notice requirements. This is a licensing note;
  see `LICENSE`.

## Out of scope

- Anything requiring the attacker to already have write access to the operator's
  machine, the data folder, or the source tree. The trust boundary is the
  network and the scanned page.
- Denial of service against your own machine by scanning a pathological site.
  The fetch has size and redirect bounds; a site that merely wastes your time is
  a quality issue.
- Social-engineering the operator into approving a bad artifact. The whole
  approval flow is designed to make that a deliberate act; it cannot stop an
  operator who overrides their own judgement.
- Vulnerabilities in Node, Electron, or Chromium themselves. Report those
  upstream; we will pick up patched runtimes as they ship.

## Disclosure

Coordinated disclosure. Once a fix is on `main`, the advisory is published
with credit. Please give the fix a reasonable window to land before disclosing
publicly.
