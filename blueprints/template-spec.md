# Template: Spec (family `spec`)

A spec tells someone what to build and how it will be judged. Deliverables:
`requirements.md`, design docs saved with `save_design_doc`, `analytics-spec.md`,
`localization-spec.md`, `campaign-brief.md`, `publishing-plan.md`,
`solution-sow.md`, `pricing.md`. (Playbook `spec.md` / `plan.md` and the
operator's `plan.md` keep their own exact sections; they are not linted
against this template.)

At a Spec Approval or Plan Approval gate the reader is a human deciding "is
this the right thing / the right way?" and reads only `## Outcome` and
`## Scope` before tapping. Write those two for that reader.

## Sections (exact `##` headings, this order)
1. `## Outcome`. What exists when this is done and for whom, in one to three
   sentences. State the one architectural or product choice that defines the
   approach. No lists, under 80 words.
2. `## Scope`. In and out, as two short lists. Name the surfaces touched and
   the ones deliberately untouched. Assumptions you made in place of an
   answer are listed here, flagged.
3. `## Approach`. What will be built, in the order it lands. Design detail
   (data model, API, screens, service boundaries, sequence) lives here as
   `###` sub-headings, each opening with its decision and why.
4. `## Acceptance`. How the work is judged: numbered criteria a test or a
   human can check, the tests to add, the evidence to produce.

Appendix `##` sections after `## Acceptance` are allowed for what the builder
may need but the approver will not: risks and open questions, references,
policy answers, ticket plan.

## Example (real run wf_1789671047405_e19l5v requirements.md, first sections rewritten; original was 48 KB)

```
# Requirements: binding gates, silent-death recovery, sweep exit (TEAM-4734)

## Outcome
Four rails the system owns stop leaking time: a typed gate cannot close until
its condition clears, a persona turn that dies mid-stream is retried in place
and a turn that ends without a report is detected within 60 s, an unchanged
main skips the dead-code sweep, and work is never dispatched against a branch
frozen behind an open merge gate. Target across the affected run classes:
wall-clock -63 %, cost -26 %, achieved by deleting work, not adding it.

## Scope
In: orchestrator completion gate for typed human tickets, the Telegram bridge
approve path, runtime in-turn ConverseStream retry and end-of-turn death
event, watchdog coverage of human-parked runs, sweep preflight, open-gate
branch freeze. Fourteen functional requirements, FR-1 to FR-14.
Out: any new Lambda, orchestrator module, env flag, UI route or table. The
eval SI loop. Filed elsewhere: TEAM-3268 stream retry history.
Assumed: hub-infra fix tickets target main (FR-5), pending confirmation.

## Approach
### Gates bind (FR-1 to FR-5)
A typed gate ticket moving to done is refused unless its guarded condition
cleared; the bridge approves the pipeline stage it names; a second
start_deploy behind a held Approval stage is refused.
### The harness cannot die silently (FR-6 to FR-8)
...
### The sweep has an exit (FR-9 to FR-11)
...
### Frozen branches are not built on (FR-12 to FR-14)
...

## Acceptance
1. A gate ticket with an uncleared condition cannot reach done (unit + live).
2. A ConverseStream internalServerException retries in-turn, max 2, logged.
3. A turn ending without report_completion emits agent.died within 60 s and
   the same persona is resumed once.
4. A sweep on an unchanged main creates 0 agent tickets and completes.
...
```
