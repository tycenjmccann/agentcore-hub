// Bounded-retry / rate-control primitives for the battery's Bedrock calls
// (TEAM-3352). Every retry in the runner must be bounded in ATTEMPTS and in
// ELAPSED TIME, always backed off with jitter (never an immediate re-fire),
// and every wait must be abortable so a case deadline can cut through it.
// Pure and dependency-free so vitest can drive everything with fake clocks.

/**
 * Jittered exponential backoff: full window doubles per retry, capped, and the
 * actual delay is drawn from the upper half of the window ("equal jitter") so
 * concurrent workers never re-fire in lockstep.
 * @param {number} retry 1-based retry ordinal
 */
export function backoffDelayMs(retry, { baseMs = 500, capMs = 8000, random = Math.random } = {}) {
  const window = Math.min(capMs, baseMs * 2 ** (Math.max(1, retry) - 1));
  return Math.round(window / 2 + random() * (window / 2));
}

/** Abort-aware sleep. Resolves (never rejects) early on abort — the caller
 *  re-checks the signal and decides how to fail. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A retry budget bounded in both attempts and wall-clock elapsed time.
 * `tryConsume()` returns false once either bound is spent — the caller then
 * surfaces the original error instead of retrying.
 * @param {{ maxRetries: number, maxElapsedMs?: number, now?: () => number }} budget
 */
export function createRetryBudget({ maxRetries, maxElapsedMs = Infinity, now = () => Date.now() } = {}) {
  const startedAt = now();
  let used = 0;
  return {
    get used() {
      return used;
    },
    tryConsume() {
      if (used >= maxRetries) return false;
      if (now() - startedAt >= maxElapsedMs) return false;
      used += 1;
      return true;
    },
  };
}

/**
 * Counting semaphore for the global Bedrock request gate: at most `limit`
 * Converse calls (agent turns + judge calls combined) are in flight at once,
 * regardless of how many case workers the pool runs. Permits are released in
 * `finally`, so a rejected call can never leak one.
 */
export function createSemaphore(limit) {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];
  return {
    async run(fn) {
      if (active < limit) active += 1;
      else await new Promise((resolve) => waiters.push(resolve)); // resolver hands over the permit
      try {
        return await fn();
      } finally {
        const next = waiters.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

/**
 * Propagate an abort from `signal` into `controller` (with the same reason).
 * Returns an unlink function — always call it when the dependent work finishes
 * so long-lived signals (the whole-run watchdog) don't accumulate listeners.
 */
export function linkAbort(signal, controller) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
