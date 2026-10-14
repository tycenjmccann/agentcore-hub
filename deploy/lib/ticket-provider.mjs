/**
 * ticket-provider.mjs — the single TICKET_PROVIDER default for the deploy
 * layer (TEAM-6087).
 *
 * Before this module, deploy/setup-tickets-lambda.mjs defaulted an unset
 * TICKET_PROVIDER to "dynamodb" while every other deploy script that reads
 * it (lambda/orchestrator/deploy.sh, lambda/workflow-output/deploy.sh,
 * deploy/runtime-agent/deploy-one.sh, deploy-one-robust.py,
 * deploy/ticket-provider-probe/deploy.sh, the Dockerfile, .env.example)
 * defaulted to "jira". An install that left the var unset created the
 * tickets Lambda under one name while the runtimes' TICKET_TOOLS_LAMBDA
 * pointed at the other.
 *
 * "jira" is canonical for the DEPLOY layer: it's what ships
 * (Dockerfile ENV, .env.example) and what every runtime deploy script
 * already defaults TICKET_TOOLS_LAMBDA to. This module is the one place
 * that default lives for the two Node setup scripts
 * (deploy/setup-tickets-lambda.mjs, deploy/workflow-manager/setup-workflow-
 * manager.mjs); the shell scripts above keep their own `${TICKET_PROVIDER:-
 * jira}` / `${TICKET_TOOLS_LAMBDA:-agentcore-hub-jira}` literals (a .mjs
 * can't source bash), kept in sync with DEFAULT_TICKET_PROVIDER by
 * deploy/lib/__tests__/ticket-provider.test.ts.
 *
 * Deliberately NOT the default for runtime code (lambda/orchestrator/
 * index.mjs, agent-invoker.mjs, lambda/workflow-output/index.mjs,
 * src/app/api/**, deploy/runtime-agent/main.py, the workflow-manager
 * toolkit) — those stay "dynamodb" when unset, unchanged by this fix.
 */

export const DEFAULT_TICKET_PROVIDER = "jira";

/** Resolve TICKET_PROVIDER from env, defaulting to DEFAULT_TICKET_PROVIDER. */
export function resolveTicketProvider(env = process.env) {
  return (env.TICKET_PROVIDER || DEFAULT_TICKET_PROVIDER).toLowerCase();
}

/** The ticket-tools Lambda function name for a given provider. */
export function ticketToolsLambdaName(provider) {
  return provider === "jira" ? "agentcore-hub-jira" : "agentcore-hub-tickets";
}
