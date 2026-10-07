/**
 * TEAM-5405 — test-only helper. Never imported by app code.
 *
 * TEAM-5399 turned releaseCloseoutLease's UpdateExpression (cancel-run.ts)
 * from a fixed string into an assembled one; the REMOVE/SET attribute lists
 * are the same, but their order inside each clause is no longer fixed (and
 * DynamoDB never cares about that order). Tests that need to assert exactly
 * which attributes a clause touches should parse the expression into sorted
 * lists with this helper instead of pinning a literal attribute order.
 */
export function updateClauses(expr: string): { REMOVE: string[]; SET: string[] } {
  const clauses: { REMOVE: string[]; SET: string[] } = { REMOVE: [], SET: [] };
  for (const m of expr.matchAll(/(SET|REMOVE)\s+(.*?)(?=\s+(?:SET|REMOVE)\s|$)/g)) {
    const kind = m[1] as "SET" | "REMOVE";
    clauses[kind] = m[2]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .sort();
  }
  return clauses;
}
