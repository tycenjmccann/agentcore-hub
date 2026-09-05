import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4079 F3 regression suite for the DEFAULT (non-injected) STS path.
 *
 * Root cause: `defaultAccountIdProbe` memoized the probe promise unconditionally,
 * so a single transient failure (cold-start credential refresh, throttle, network
 * blip) cached `undefined` for the lifetime of the process — every later
 * submission lost the hub-bucket label with no way to recover short of a restart.
 *
 * This lives in its own file because it has to vi.mock("@aws-sdk/client-sts") at
 * module scope, which intake.test.ts must not do (it exercises the real
 * constructor-free injected-client path).
 */

const h = vi.hoisted(() => ({
  send: vi.fn(),
  ctorArgs: [] as unknown[],
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = h.send;
    constructor(config: unknown) {
      h.ctorArgs.push(config);
    }
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Imported after the mock is registered; vitest hoists vi.mock above this anyway.
import { resolveHubBucket, __resetHubBucketProbeCacheForTests } from "./intake";

const envOf = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv;

// No ARTIFACT_BUCKET / AWS_ACCOUNT_ID, so the account id can only come from STS.
const ENV = envOf({ AWS_REGION: "us-east-1" });
const EXPECTED = "agentcore-hub-artifacts-111122223333-us-east-1";

describe("resolveHubBucket — a failed default probe is not cached (F3)", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.ctorArgs.length = 0;
    __resetHubBucketProbeCacheForTests();
  });

  it("retries after a transient failure, then memoizes the success", async () => {
    h.send
      .mockRejectedValueOnce(
        Object.assign(new Error("Could not load credentials from any providers"), {
          name: "CredentialsProviderError",
        })
      )
      .mockResolvedValue({ Account: "111122223333" });

    // 1st: the probe rejects -> undefined, and must NOT stick.
    await expect(resolveHubBucket({ env: ENV })).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);

    // 2nd: on base this returned undefined from the cached failed promise.
    await expect(resolveHubBucket({ env: ENV })).resolves.toBe(EXPECTED);
    expect(h.send).toHaveBeenCalledTimes(2);

    // 3rd: the SUCCESS is still memoized — no third round trip.
    await expect(resolveHubBucket({ env: ENV })).resolves.toBe(EXPECTED);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("does not cache an account-less identity response either", async () => {
    h.send.mockResolvedValueOnce({}).mockResolvedValue({ Account: "111122223333" });

    await expect(resolveHubBucket({ env: ENV })).resolves.toBeUndefined();
    await expect(resolveHubBucket({ env: ENV })).resolves.toBe(EXPECTED);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("bounds the default client: maxAttempts 1 plus a request/connection timeout", async () => {
    h.send.mockResolvedValue({ Account: "111122223333" });
    await resolveHubBucket({ env: ENV });

    expect(h.ctorArgs).toHaveLength(1);
    const config = h.ctorArgs[0] as {
      region?: string;
      maxAttempts?: number;
      requestHandler?: { requestTimeout?: number; connectionTimeout?: number };
    };
    // Without maxAttempts:1 the SDK retries 3x underneath the race, so the
    // timeout ceiling would only bound the FIRST attempt.
    expect(config.maxAttempts).toBe(1);
    expect(config.region).toBe("us-east-1");
    expect(config.requestHandler?.requestTimeout).toBeGreaterThan(0);
    expect(config.requestHandler?.connectionTimeout).toBeGreaterThan(0);
  });

  it("never constructs a client when the bucket is already known from env", async () => {
    await expect(
      resolveHubBucket({ env: envOf({ ...ENV, ARTIFACT_BUCKET: "explicit-bucket" } as Record<string, string>) })
    ).resolves.toBe("explicit-bucket");
    await expect(
      resolveHubBucket({ env: envOf({ ...ENV, AWS_ACCOUNT_ID: "111122223333" } as Record<string, string>) })
    ).resolves.toBe(EXPECTED);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ctorArgs).toHaveLength(0);
  });
});
