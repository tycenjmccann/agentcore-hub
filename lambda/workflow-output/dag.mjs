/**
 * TEAM-3992 D3.4 — workflow-output's view of the ticket-DAG validator.
 *
 * The AUTHORITATIVE module is lambda/orchestrator/dag.mjs (its parity twin is
 * src/lib/workflow/dag.ts). workflow-output ships as its own single-directory
 * zip, so a `../orchestrator/dag.mjs` import cannot resolve at runtime — instead
 * this file re-exports it for the repo (tests, tsc, node --check, which run with
 * the tree intact), and lambda/workflow-output/deploy.sh OVERWRITES this file
 * with a concrete copy of lambda/orchestrator/dag.mjs at build time so the flat
 * Lambda zip resolves `./dag.mjs` with zero source drift.
 */
export * from "../orchestrator/dag.mjs";
