// Bounded-retry / rate-control primitives (TEAM-3352). Pure — no AWS, no fs.
import { describe, it, expect } from "vitest";
import { backoffDelayMs, sleep, createRetryBudget, createSemaphore, linkAbort } from "../lib/retry.mjs";

describe("backoffDelayMs", () => {
  it("draws from the upper half of an exponentially growing window", () => {
    expect(backoffDelayMs(1, { baseMs: 500, random: () => 0 })).toBe(250);
    expect(backoffDelayMs(1, { baseMs: 500, random: () => 1 })).toBe(500);
    expect(backoffDelayMs(2, { baseMs: 500, random: () => 0 })).toBe(500);
    expect(backoffDelayMs(3, { baseMs: 500, random: () => 1 })).toBe(2000);
  });

  it("caps the window and never returns zero (no immediate re-fires)", () => {
    expect(backoffDelayMs(30, { baseMs: 500, capMs: 8000, random: () => 1 })).toBe(8000);
    for (let retry = 1; retry <= 10; retry++) {
      expect(backoffDelayMs(retry, { random: () => 0 })).toBeGreaterThan(0);
    }
  });
});

describe("createRetryBudget", () => {
  it("is bounded in attempts", () => {
    const budget = createRetryBudget({ maxRetries: 2, maxElapsedMs: 60_000 });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(2);
  });

  it("is bounded in elapsed time even with attempts remaining", () => {
    let t = 0;
    const budget = createRetryBudget({ maxRetries: 100, maxElapsedMs: 1000, now: () => t });
    expect(budget.tryConsume()).toBe(true);
    t = 1000; // clock hits the elapsed cap
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(1);
  });
});

describe("sleep", () => {
  it("resolves early (never rejects) when the signal aborts", async () => {
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 20);
    await sleep(10_000, ctl.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves immediately on an already-aborted signal", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const started = Date.now();
    await sleep(10_000, ctl.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("createSemaphore", () => {
  it("caps concurrent execution at the limit and drains the queue", async () => {
    const sem = createSemaphore(3);
    let inflight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        sem.run(async () => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await new Promise((r) => setTimeout(r, 10));
          inflight -= 1;
          return i;
        })
      )
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("releases the permit when the task rejects — no leak", async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // Permit must be back: the next task runs.
    expect(await sem.run(async () => "ran")).toBe("ran");
  });
});

describe("linkAbort", () => {
  it("forwards an abort with its reason into the target controller", () => {
    const src = new AbortController();
    const dst = new AbortController();
    linkAbort(src.signal, dst);
    src.abort(new Error("run deadline of 780s exceeded"));
    expect(dst.signal.aborted).toBe(true);
    expect((dst.signal.reason as Error).message).toBe("run deadline of 780s exceeded");
  });

  it("aborts immediately when the source is already aborted, and unlink stops forwarding", () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("late"));
    const dst1 = new AbortController();
    linkAbort(preAborted.signal, dst1);
    expect(dst1.signal.aborted).toBe(true);

    const src = new AbortController();
    const dst2 = new AbortController();
    const unlink = linkAbort(src.signal, dst2);
    unlink();
    src.abort(new Error("after unlink"));
    expect(dst2.signal.aborted).toBe(false);
  });

  it("is a no-op for a missing signal", () => {
    const dst = new AbortController();
    const unlink = linkAbort(undefined, dst);
    unlink();
    expect(dst.signal.aborted).toBe(false);
  });
});
