# Assay Roadmap

**State as of 2026-08-03.**

Ordered by priority and deliberately undated. This is a one-person project, and
a roadmap with dates on it would be a promise the schedule cannot keep. **The
order is the commitment. The timing is not.**

Three things are absent from this list because they are not going to change:
the five laws in the [README](README.md), scoring computed by code rather than
by a model, and the rule that a finding has to be reconciled against raw source
before it can reach a document. Anything that would require breaking one of
those is not on this roadmap and will not be added to it.

---

## The objection this roadmap has to answer first

Three things this repo calls deliberate are on this list. There is no sender.
Everything runs through the window. Confirmations do not survive a restart, on
purpose. A reader can put those three sentences next to these three items and
conclude that "on purpose" was only ever "not yet."

A file cannot prove intent, because I am the one person who can edit it. A test
can. Before any sender ships, the suite gets a case that fails the build on any
send path that does not take exactly one artifact per explicit human action: no
queue, no batch, no send-all, no schedule. Same for any path that approves an
artifact without a human action. Weakening that test is easier than deleting it,
so check the assertion rather than the filename.

Until that test exists there is nothing on this page a reader can verify. And
the pacing rule that would notice a fast sequence
(`src/main/confirmation/policy.ts`) warns rather than blocks, so today the only
thing between the shipped design and a sequence is a person clicking N times.

**A sender sends one artifact when I click send. A sequence sends many without
me.** The first is a convenience I want. The second is what this tool exists in
opposition to.

---

## 1. Sending

There is no sender. `src/main/send/provider.ts` defines a `PostcardProvider`
signature and nothing implements it. Every approved artifact is registered in a
module-private `WeakSet` at the moment it is minted, so `assertMinted` refuses
anything that did not come through the approval gate. The `unique symbol` on
the type is a compile-time brand and is erased at build; the runtime guarantee
is the set.

The gap that leaves is real. The operator approves an artifact and then leaves
the app to send it by hand, which means the record of what actually went out
lives in an email client instead of in the tool that built it. `04-sent/` is
never created in any client folder, because nothing in `src/` touches
`paths.sent`; the data root marks it reserved for exactly that record.
`03-approved/` is in the same state.

Note also that the signature that exists today is for physical mail. The story
above is about email, and that signature has not been written.

What a sender has to satisfy before it ships:

- the refusal test described above lands first, not alongside
- it calls `assertMinted`, and a failed assertion halts rather than warns
- one artifact per explicit human action. No queue, no batch, no send-all, no
  schedule
- it cannot send an artifact whose bytes changed after approval, or one that a
  later scan has superseded, which is what the gate already refuses
- it writes what went out, when, and to which address into `04-sent/`, which the
  data root already reserves for exactly that
- it refuses anything on `blocklist.json`, and it raises the first-contact
  pacing warning at the moment of sending. Pacing warns rather than blocks by
  design, and that does not change here

**This changes what enforces Law 3, and the README will say so.** Today Law 3's
enforcement cell leads with `assertMinted` and the `WeakSet`, and notes that no
sender implementation exists yet; `provider.ts` was written before any provider
precisely so the law would outlive that accident of scheduling.

What this deliberately does not become: a campaign tool. The day sending grows a
scheduler or a list import, it has stopped being this project.

## 2. A programmatic surface

There is already a headless path of sorts: `scripts/check-one.js` drives
`runChecks` end to end from plain node, with no Electron and no Places key, and
`scripts/test-confirmation.js` does the same inside the suite. What is missing
is a supported surface carrying the same gates, rather than a dev script.

Likely shape: a CLI, or a local HTTP server, sitting on the same IPC handlers
the UI already drives. Same checks, same gates, one code path. A second scoring
path would be a way for the two to disagree, and a score that depends on how you
invoked it is not a score.

The constraint that makes this the interesting item: **reconciliation is a human
step on purpose.** It means a person opened the page in their own browser and
pasted back what they saw, which no script can stand in for. So a headless run
scores and stops. It does not produce an artifact marked unconfirmed; it
produces no artifact at all, because `generatePacket` throws `NotReleasableError`
on unreconciled findings and that refusal is not moving.

**A local HTTP server rewrites SECURITY.md's threat model**, whose first
paragraph states "there is no server." An unauthenticated listener on localhost is
drivable by any other process on the machine and by any page open in the
operator's browser. So it does not ship without a token and an origin refusal,
and the approval and send channels are not exposed on it at all.

Done looks like a scan invoked from a script returning the same findings and the
same evidence references the window shows, a generation attempt refusing with
the same error the window gets, and the approval gate being unreachable from
outside the app.

## 3. Interoperability with agent platforms

The goal: an assistant such as ChatGPT, Claude or Gemini can call Assay as a
tool and get back a scored finding that carries its evidence, rather than a
plausible guess about a website.

Likely shape: an MCP server on top of the item above, exposing scan and read
operations only.

**What this actually grants, stated the unflattering way.** The agent inside
this app cannot fetch, browse or search; it takes text
and returns text. An outside agent calling a `scan` tool gets *more* than that,
because handing Assay a URL causes a fetch. It would spend the operator's
metered Places quota and put the operator's IP behind the request. The existing
guard refuses private and loopback addresses, and it does nothing about being
pointed at arbitrary public sites all day.

So the item carries its own conditions: the server is rate-limited per operator,
it logs every scan it was asked to run and by whom, and it refuses a target the
operator has not accepted. It cannot reconcile, it cannot approve, and it cannot
send.

It is worth building anyway. This tool measures which machine-readable signals a
business publishes for an assistant to read, and a version of that measurement
the assistants can run themselves closes the loop.

---

## Under consideration, not committed

- more checks past the current six, with the calibration work to match
- a wider calibration set for the AI-readiness instrument, which is calibrated
  against two delivered client scans, publishing three scored properties
  between them, and nothing else
- discovery that does not depend on Google Places
- confirmations that survive a restart and display their own age. They expire
  after 72 hours today and are gone when the app closes, which the README calls
  deliberate, and it is: the reason to revisit it is the age display, not the
  persistence

## Not planned

- bulk sending, scheduled sending, or anything resembling a sequence
- scraped or purchased contact lists
- a model writing or altering a finding
- auto-posting to social platforms
- a hosted or multi-tenant version. This is a local-first tool for one operator,
  and the data root design assumes exactly that

## Influencing any of this

Open an issue using the feature request template. The most useful issue tells me
what you were trying to do and what the tool made you do instead.
