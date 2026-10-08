/**
 * Shared source-text extractors for the ticket-twin parity suites
 * (closeout-name-parity.test.ts, tool-signature-parity.test.ts).
 *
 * TEAM-5408 split the Jira twin's `transitionTicket` into a thin
 * TerminalStatusRefusal-catching wrapper plus a `transitionTicketUnguarded`
 * that does the real work (`lambda/agentcore-hub-jira/index.mjs`), so a
 * per-function source slice keyed on the entry point's own name sees only the
 * wrapper and misses the destructure and the gate-contract call inside it.
 *
 * `entrySource` (TEAM-5411) follows exactly one shape of delegation — an
 * entry whose body forwards its own single parameter UNCHANGED to another
 * function of the same arity (`await x(p)`, nothing else in the parens, both
 * sides named `p`) — and refuses anything else. A wrapper that rewrites or
 * partially forwards its argument (`{ ...params }`, `(params, extra)`, a
 * renamed parameter) is NOT followed, so the caller's regex runs against the
 * wrapper and fails, instead of the mismatch being silently skipped past.
 */

/** The body of `async function <name>(` up to the next top-level function
 *  (`function`/`async function`, optionally `export`ed). Matches on `name(`,
 *  so `transitionTicket` never matches `transitionTicketUnguarded`. */
export function functionSource(src: string, name: string, label: string = name): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) {
    throw new Error(`${label}: async function ${name} not found — the extractor is stale`);
  }
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

export interface EntrySource {
  /** The entry point's own slice (the wrapper, when there is one). */
  entry: string;
  /** The slice that actually reads the arguments: the entry itself, or
   *  whatever it delegates its whole, unmodified parameter to. */
  body: string;
  /** The delegation chain, entry first. Length 1 when nothing was followed. */
  chain: string[];
}

/** Depth cap: real delegation chains in these twins are one hop; this just
 *  keeps a cycle or a long chain from looping unboundedly. */
const MAX_DEPTH = 3;

/** `functionSource`, but follows a bare single-argument forward. See the file
 *  header for exactly what is followed and what is not. */
export function entrySource(src: string, name: string, label: string = name): EntrySource {
  const chain = [name];
  let current = name;
  const entry = functionSource(src, name, label);
  let body = entry;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const sig = new RegExp(`async function ${current}\\(\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)`).exec(
      body,
    );
    if (!sig) break;
    const param = sig[1];
    // `await <callee>(<param>)` — exactly that one identifier in the parens,
    // nothing added or spread, nothing dropped.
    const forward = new RegExp(`await (\\w+)\\(\\s*${param}\\s*\\)`).exec(body);
    if (!forward) break;
    const callee = forward[1];
    if (chain.includes(callee)) break; // cycle guard
    // The callee has to accept that same bare parameter — same name, no
    // rename across the hop — or this is not the shape we follow.
    if (!new RegExp(`async function ${callee}\\(\\s*${param}\\s*\\)`).test(src)) break;
    current = callee;
    chain.push(callee);
    body = functionSource(src, callee, label);
  }

  return { entry, body, chain };
}
