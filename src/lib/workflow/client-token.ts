/**
 * TEAM-5780: builds the `client_token` the DynamoDB tickets Lambda's
 * `create_ticket` uses for idempotency (TEAM-5712,
 * `lambda/agentcore-hub-tickets/index.mjs`). An AWS SDK resend of a
 * create_ticket Invoke whose first attempt's Put already landed used to mint a
 * second ticket; a token makes the resend converge on the first ticket instead.
 *
 * Only direct hub-to-Lambda create_ticket callers that can be resent (the
 * start route's epic/gate/plan-item creates, the cancel route's post-run epic,
 * workflow-output's follow-up materialization) build one — each from durable
 * ids already in hand, so the token is identical on every resend of the same
 * logical create and distinct from every other one.
 *
 * `CLIENT_TOKEN_RE` is a byte-identical copy of the Lambda's own (not exported
 * there, so `follow-ups-parity.test.ts` pins the copy by reading the Lambda's
 * source as text — same technique that file already uses for `main.py`,
 * which cannot be imported either). A token built here MUST pass the Lambda's
 * check: TEAM-5712 validates `client_token` before any ticket id is minted, so
 * a malformed token refuses the create outright instead of just skipping
 * idempotency.
 */
export const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Join `parts` with "-" into a token, or `undefined` if the result doesn't pass CLIENT_TOKEN_RE. */
export function clientToken(...parts: string[]): string | undefined {
  const token = parts.join("-");
  return CLIENT_TOKEN_RE.test(token) ? token : undefined;
}

/**
 * `{ client_token }` when buildable, else `{}` — spread straight into a
 * create_ticket `parameters` object so an unbuildable token degrades to the
 * pre-TEAM-5780 behavior (no idempotency) rather than refusing the create.
 */
export function clientTokenParam(...parts: string[]): { client_token?: string } {
  const token = clientToken(...parts);
  return token ? { client_token: token } : {};
}
