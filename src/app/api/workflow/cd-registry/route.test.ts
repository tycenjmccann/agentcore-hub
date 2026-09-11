import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4416 — POST /api/workflow/cd-registry now shape-validates the body
 * (src/lib/cd-registry.ts validateCdEntryInput) before it ever reaches S3, so a
 * typo'd region/pipeline/deployDoc fails with a 400 here instead of an opaque
 * AWS error deep inside a Lambda later (docs/agents-own-cd.md "runtime
 * allow-list"). Same S3-mock-at-the-module-seam pattern as
 * src/app/api/workflow/[id]/complete/route.test.ts.
 */

const h = vi.hoisted(() => ({
  state: {
    // config/cd-registry.json body, keyed by S3 key; undefined = NoSuchKey.
    s3Objects: {} as Record<string, string>,
    puts: [] as Array<{ Key: string; Body: string }>,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      if (name === "GetObjectCommand") {
        const key = cmd.input.Key as string;
        const body = h.state.s3Objects[key];
        if (body === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => body } };
      }
      if (name === "PutObjectCommand") {
        const key = cmd.input.Key as string;
        const body = cmd.input.Body as string;
        h.state.puts.push({ Key: key, Body: body });
        h.state.s3Objects[key] = body;
        return {};
      }
      throw new Error(`unexpected S3 command ${name}`);
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

let POST: typeof import("./route").POST;

async function load() {
  vi.resetModules();
  ({ POST } = await import("./route"));
}

const SAVED = ["ARTIFACT_BUCKET"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(async () => {
  h.state.s3Objects = {};
  h.state.puts.length = 0;
  for (const k of SAVED) saved[k] = process.env[k];
  // ARTIFACT_BUCKET is read at module load (src/lib/cd-registry.ts), so it must
  // be set before the dynamic import.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  await load();
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/workflow/cd-registry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/workflow/cd-registry — validation", () => {
  it("an invalid payload is rejected before any S3 write, with every bad field reported", async () => {
    const res = await post({ repo: "hub", region: "us-east-11", pipeline: "my pipe", deployDoc: "../x" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_field");
    expect(body.fields).toEqual({
      repo: "must be owner/repo or a GitHub URL",
      region: "must be an AWS region like us-east-1 or us-gov-west-1",
      pipeline: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])",
      deployDoc: "must not contain a .. path segment",
    });
    expect(h.state.puts).toHaveLength(0);
  });

  it("a fully valid payload with every optional field set still succeeds unchanged", async () => {
    const res = await post({
      repo: "https://github.com/Acme/Juno.git",
      pipeline: "hub-juno-deploy",
      region: "us-east-1",
      ciProject: "hub-juno-ci",
      deployDoc: "docs/DEPLOY.md",
      notes: "onboarded by ops",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.entry).toMatchObject({
      repo: "acme/juno",
      pipeline: "hub-juno-deploy",
      region: "us-east-1",
      ciProject: "hub-juno-ci",
      deployDoc: "docs/DEPLOY.md",
      notes: "onboarded by ops",
    });
    expect(h.state.puts).toHaveLength(1);
    const persisted = JSON.parse(h.state.puts[0].Body);
    expect(persisted.repos).toEqual([
      expect.objectContaining({
        repo: "acme/juno",
        pipeline: "hub-juno-deploy",
        region: "us-east-1",
        ciProject: "hub-juno-ci",
        deployDoc: "docs/DEPLOY.md",
        notes: "onboarded by ops",
      }),
    ]);
  });

  it("an empty string on an existing entry's pipeline still clears it (not rejected as invalid)", async () => {
    h.state.s3Objects["config/cd-registry.json"] = JSON.stringify({
      version: 1,
      repos: [{ repo: "acme/juno", pipeline: "hub-juno-deploy", region: "us-east-1" }],
    });
    const res = await post({ repo: "acme/juno", pipeline: "" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.pipeline).toBeUndefined();
    expect(body.entry.region).toBe("us-east-1");
    const persisted = JSON.parse(h.state.puts[0].Body);
    const juno = persisted.repos.find((e: { repo: string }) => e.repo === "acme/juno");
    expect(juno.pipeline).toBeUndefined();
  });
});
