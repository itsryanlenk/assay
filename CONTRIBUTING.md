# Contributing

Thanks for looking at Assay. It is a small, opinionated, single-purpose
tool, and the bar for a change is that it keeps the tool's one promise true:
**every claim in a deliverable can be reproduced by the recipient with Ctrl+U.**
That promise is why several things here are stricter than a typical app.

## Ground rules

- **The five laws are load-bearing.** Each law in the [README](README.md) has
  a named enforcement point: a test or a type. A change that
  weakens a law must not merge, and in most cases the build will stop you before
  a reviewer does. If you think a law is wrong, open an issue to discuss the law
  first; don't route around it in a PR.
- **No secrets, no client data, ever.** Nothing under `data/`, no API keys, no
  real business names, no personal contact details reach a tracked file. The
  preflight gate scans every file git would publish and fails the build on a key
  shape, an absolute user path, or a live email domain. Do not disable it to get
  green.
- **Tests before implementation.** This engine is reconciliation-heavy and easy
  to get subtly wrong. New behavior lands as a failing test first, then the
  implementation that turns it green.

## Getting set up

Requires **Node 20+** and runs on Windows, macOS, or Linux.

```bash
npm install
npm start
```

Build outputs land in `dist/` and `out/` (both gitignored). Fonts and Leaflet
are npm dependencies copied in at build time by `npm run build:assets`; neither
is vendored into the repo.

## The test suite

```bash
npm test
```

This runs two gates and six suites. All must pass to open a PR.

- **preflight** scans every publishable file for secrets, absolute paths, and
  live email domains. A leak fails the build rather than warning.
- **smoke** boots the real Electron window, fails on console errors, CSP
  violations, or preload faults, and drives the navigation. Losing the
  single-instance lock is a failure here, because a gate that cannot tell
  "passed" from "never ran" is no gate at all.
- **IPC**, **parsers**, **instrument calibration**, **confirmation gate**,
  **packet generation**, and **approval queue** cover the engine end to end.
  The calibration suite fails the build if the scoring instrument stops
  reproducing the three published client scores.

Useful subsets while iterating:

```bash
npm run typecheck      # tsc --noEmit
npm run test:parsers   # engine unit checks
npm run preview        # render the UI to a PNG without spending a Places request
```

## What a good change looks like

1. **Scope it small.** One behavior per PR. The commit history here favors
   short, self-contained commits with a message that says what changed and why
   it mattered, not a changelog of files.
2. **Prove it.** A bug fix includes the failing test that reproduces the
   original symptom; a feature includes the tests that pin its behavior. The
   evidence is the re-run, with its output.
3. **Keep the laws enforced.** If your change touches scoring, evidence,
   approval, or discovery, name the enforcement point you're preserving in the
   PR description.
4. **Don't grow the network surface.** `fetch-raw.ts` is the only egress to a
   target site, and it is deliberately narrow. New outbound calls need a very
   good reason and a matching guard.
5. **Claim only what the scan measured.** Owner-facing text in a packet must
   never assert more than the scan checked. Several past bugs were copy
   asserting an absence the scan never looked for; reviewers watch for this
   specifically.

## Reporting bugs and requesting features

- **Bugs:** open an issue with what you did, what you expected, and what
  happened. A reproduction is worth more than a description: a URL that scans
  wrong, or a packet that renders wrong.
- **Security issues:** do **not** open a public issue. See
  [SECURITY.md](SECURITY.md).
- **Features:** open an issue describing the problem before the solution. This
  tool says no to a lot of features on purpose (no auto-anything); a
  feature that adds bulk sending, scheduled sending, or auto-approval will not
  land. A single-artifact sender is on the [roadmap](ROADMAP.md), with the
  conditions it has to satisfy first.

## Code style

TypeScript, strict. Match the surrounding code: comment density, naming, and
idiom. Comments explain a constraint the code can't show, not what the next line
does. There is no separate lint step; `npm run typecheck` and the reviewers are
the gate.

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
