# Replay fixtures (TEAM-5322)

Read by `../replay-decision-contract.test.mjs`. Source: the TEAM-5317 fixture export
(`workflows/wf_1791220686225_znl7a4/shared/fixtures/` in the artifact bucket), already
redacted there (account ids → `000000000000`, no tokens, no chat ids). Nothing here
was re-fetched from a live table.

| File | What it is |
|---|---|
| `TEAM-5148-decision-bound-gate.synthetic.json` | Synthetic decision-bound gate + `expected[]` rows (copied verbatim). |
| `workflow-33rea7.json`, `workflow-1ykx9f.json` | Workflow rows (copied verbatim). |
| `events-33rea7.gates.json` | Extract: TEAM-5204 (sweeper), TEAM-5209 (Merge Approval gate). |
| `events-TEAM-5259.gates.json` | Extract: TEAM-5273, TEAM-5278, TEAM-5279 (escalation gates). |
| `events-1ykx9f.gates.json` | Extract: TEAM-4931 (deploy gate), TEAM-4939, TEAM-4954. |
| `events-znl7a4.gates.json` | Extract (TEAM-5391) from `../../orchestrator/fixtures/events-znl7a4.json`: TEAM-5352 (escalation gate), TEAM-5325 (its review ticket). |
| `events-o1l3to.gates.json` | Extract (TEAM-5391) from `../../orchestrator/fixtures/events-o1l3to.json`: TEAM-5314 (escalation gate), TEAM-5305 (its ship ticket). |

Extract filter for the `events-*.gates.json` files: rows whose `type` is not
`agent.streaming` and whose `detail` mentions one of the listed ticket ids,
de-duplicated on `type` + `detail.timestamp`, sorted by `timestamp`.

The exported `ticket.created` events carry no description, so the replay adds the
`DECISION OPTIONS:` line the chunk-D templates declare for that gate type, except
for TEAM-5352 and TEAM-5314: those are read exactly as exported (no description) to
show that an undeclared human gate admits only the default `approve | reject`
(TEAM-5391).
