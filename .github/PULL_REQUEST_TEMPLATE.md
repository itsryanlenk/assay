<!--
Thanks for contributing. Keep the PR small and single-purpose. See
CONTRIBUTING.md for the full bar. Delete any section that doesn't apply.
-->

## What this changes

<!-- One or two sentences: what behavior is different after this merges, and why
it mattered. Not a list of files. -->

## Proof

<!-- A bug fix includes the failing test that reproduced the original symptom.
A feature includes the tests that pin its behavior. Paste the relevant test
output or name the test. -->

- [ ] `npm test` passes locally (two gates + five suites)
- [ ] `npm run typecheck` is clean
- [ ] Added or updated a test that fails without this change

## The five laws

<!-- If this PR touches scoring, evidence, approval, discovery, or the packet,
name the enforcement point you're preserving. If it touches none of them, say
"n/a". -->

- Enforcement point preserved:

## Leak check

- [ ] No secrets, API keys, real business names, or personal contact details in
      any tracked file
- [ ] Nothing under `data/` is staged
- [ ] preflight passes (it runs as part of `npm test`)
