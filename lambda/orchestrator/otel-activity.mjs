/**
 * OTEL span activity probe (TEAM-3992 D4.3) — the confirmation signal for the
 * dead-session detector's soft-timeout path.
 *
 * lease.leaseVerdict returns "soft-stale" when a claim has emitted no stream/tool
 * heartbeat for >= the soft-timeout but its lease TTL has NOT expired: the agent
 * MIGHT be mid-hang, or MIGHT be doing tool work whose spans never surfaced as
 * agent.streaming rows. Before the detector steals such a claim it confirms death
 * against the OTEL trace data the fleet emits to the `aws/spans` CloudWatch Logs
 * group — a runtime that is genuinely working writes spans there even when no
 * agent.streaming event lands.
 *
 * Return contract (the sentinel leaseVerdict's `otelActivityIso` distinguishes):
 *   string    — the newest span's ISO timestamp (queried, span found).
 *   null      — queried successfully, NO span in the window (confirmed silent).
 *   undefined — UNKNOWN: not queried (flag off / budget exhausted) or the query
 *               errored/timed out. leaseVerdict treats undefined as "needs
 *               confirmation" (soft-stale), so a probe failure NEVER escalates a
 *               soft-stale to a steal on its own — the conservative default.
 *
 * Feature flag OTEL_ACTIVITY_CONFIRM=on|off (default OFF): off returns undefined
 * without any client call, so the soft-timeout path is dark until deliberately
 * enabled; the hard ceiling in leaseVerdict still catches an absolute stall.
 *
 * Cost guard: a per-sweep budget object { remaining } is passed in and decremented
 * per real query, so one sweep can never fan out an unbounded number of Logs
 * Insights queries (OTEL_QUERY_BUDGET_PER_SWEEP, default 5).
 *
 * DI: startQuery/getQueryResults are injected seams (hermetic tests); when absent,
 * a concrete @aws-sdk/client-cloudwatch-logs client is imported lazily.
 */

/** Parse an env int, falling back when unset/nonnumeric/nonpositive. */
function envInt(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** on|off flag (default off). Anything not exactly "on" (case-insensitive) is off. */
function confirmEnabled(env) {
  return String(env.OTEL_ACTIVITY_CONFIRM ?? "").trim().toLowerCase() === "on";
}

/**
 * Logs Insights `max(@timestamp)` comes back as "YYYY-MM-DD HH:mm:ss.SSS" (UTC).
 * Normalize to an ISO string; return undefined if it can't be parsed.
 */
function toIso(raw) {
  if (!raw) return undefined;
  const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function createOtelActivity(deps = {}) {
  const {
    now = () => Date.now(),
    env = process.env,
    log = (msg) => console.log(`[orchestrator] ${msg}`),
  } = deps;

  // Lazily-imported concrete client wrapper — kept behind the same seam the
  // tests inject, so importing this module never pulls the SDK on a cold path.
  let _startQuery = deps.startQuery;
  let _getQueryResults = deps.getQueryResults;
  async function ensureClient() {
    if (_startQuery && _getQueryResults) return;
    const { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } = await import(
      "@aws-sdk/client-cloudwatch-logs"
    );
    const client = new CloudWatchLogsClient({});
    _startQuery = (input) => client.send(new StartQueryCommand(input));
    _getQueryResults = (input) => client.send(new GetQueryResultsCommand(input));
  }

  /**
   * Newest OTEL span timestamp for a coding session / ticket, or the sentinel.
   * `budget` is a mutable { remaining } object shared across one sweep.
   */
  async function lastOtelActivity({ sessionId, ticketId, windowMs }, budget) {
    if (!confirmEnabled(env)) return undefined; // flag off → never query
    if (budget && budget.remaining <= 0) {
      log(`otel.budget_exhausted — skipping OTEL confirm for ticket=${ticketId || sessionId}`);
      return undefined;
    }
    if (!sessionId && !ticketId) return undefined; // nothing to key the query on

    const logGroup = env.OTEL_SPANS_LOG_GROUP || "aws/spans";
    const timeoutMs = envInt(env, "OTEL_QUERY_TIMEOUT_MS", 15_000);
    const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 3_600_000;

    // Filter on either identifier — a coding turn stamps session.id, a fleet turn
    // stamps ticket.id; either proves the far side is alive.
    const filters = [];
    if (sessionId) filters.push(`attributes.session.id = "${sessionId}"`);
    if (ticketId) filters.push(`attributes.ticket.id = "${ticketId}"`);
    const queryString = `filter ${filters.join(" or ")} | stats max(@timestamp) as lastSpan`;

    if (budget) budget.remaining -= 1; // charge the budget for a real query
    try {
      await ensureClient();
      const endTime = Math.floor(now() / 1000);
      const startTime = Math.floor((now() - window) / 1000);
      const started = await _startQuery({
        logGroupName: logGroup,
        startTime,
        endTime,
        queryString,
        limit: 1,
      });
      const queryId = started?.queryId;
      if (!queryId) return undefined;

      const deadline = now() + timeoutMs;
      // Poll until Complete or the timeout. Short fixed poll — Logs Insights over
      // a single stats row completes in well under a second in practice.
      while (now() < deadline) {
        const res = await _getQueryResults({ queryId });
        const status = res?.status;
        if (status === "Complete") {
          const rows = res.results || [];
          // stats max(@timestamp) → one row, one field { field:"lastSpan", value }.
          const field = rows[0]?.find((f) => f.field === "lastSpan");
          const iso = toIso(field?.value);
          return iso ?? null; // parsed timestamp, or null = queried, no span
        }
        if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
          log(`otel.query_${String(status).toLowerCase()} — ticket=${ticketId || sessionId}`);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      log(`otel.query_timeout — ticket=${ticketId || sessionId} after ${timeoutMs}ms`);
      return undefined;
    } catch (err) {
      log(`otel.query_error — ticket=${ticketId || sessionId} ${err?.name || "Error"}: ${err?.message || err}`);
      return undefined;
    }
  }

  return { lastOtelActivity, confirmEnabled: () => confirmEnabled(env) };
}
