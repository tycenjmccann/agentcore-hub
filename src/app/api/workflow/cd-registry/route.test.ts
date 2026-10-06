import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_HEADERS, NON_ADMIN_HEADERS, SSO_AUTH_MODE, SVC_HEADERS } from "@/lib/auth/admin-test-headers";

/**
 * TEAM-4416 — POST /api/workflow/cd-registry now shape-validates the body
 * (src/lib/cd-registry.ts validateCdEntryInput) before it ever reaches S3, so a
 * typo'd region/pipeline/deployDoc fails with a 400 here instead of an opaque
 * AWS error deep inside a Lambda later (docs/pipeline/design.md "runtime
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
let DELETE: typeof import("./route").DELETE;
let GET: typeof import("./route").GET;

async function load() {
  vi.resetModules();
  ({ POST, DELETE, GET } = await import("./route"));
}

const SAVED = ["ARTIFACT_BUCKET", "AUTH_MODE"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(async () => {
  h.state.s3Objects = {};
  h.state.puts.length = 0;
  for (const k of SAVED) saved[k] = process.env[k];
  // ARTIFACT_BUCKET is read at module load (src/lib/cd-registry.ts), so it must
  // be set before the dynamic import.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  // TEAM-5347 F9: registry writes need a signed-in human admin.
  process.env.AUTH_MODE = SSO_AUTH_MODE;
  await load();
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(body: unknown, headers: Record<string, string> = ADMIN_HEADERS) {
  return POST(new NextRequest("http://localhost/api/workflow/cd-registry", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}
function del(body: unknown, headers: Record<string, string> = ADMIN_HEADERS) {
  return DELETE(new NextRequest("http://localhost/api/workflow/cd-registry", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...headers },
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

describe("TEAM-5347 F9: registry writes need a human in the admin group (write access = deploy-trigger authority)", () => {
  const ENTRY = { repo: "acme/juno", pipeline: "hub-juno-deploy", region: "us-east-1" };
  const seeded = () => {
    h.state.s3Objects["config/cd-registry.json"] = JSON.stringify({ version: 1, repos: [ENTRY] });
  };

  it("AUTH_MODE=none: POST and DELETE are 403 default_identity (every caller is 'default' there), nothing is written", async () => {
    process.env.AUTH_MODE = "none";
    seeded();
    for (const res of [await post(ENTRY, {}), await del({ repo: "acme/juno" }, {}), await post(ENTRY, ADMIN_HEADERS)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden", reason: "default_identity" });
    }
    expect(h.state.puts).toHaveLength(0);
  });

  it("a service identity is 403 service_identity, nothing is written", async () => {
    seeded();
    expect(await (await post(ENTRY, SVC_HEADERS)).json()).toMatchObject({ error: "forbidden", reason: "service_identity" });
    expect(await (await del({ repo: "acme/juno" }, SVC_HEADERS)).json()).toMatchObject({ error: "forbidden", reason: "service_identity" });
    expect(h.state.puts).toHaveLength(0);
  });

  it("no identity headers under SSO is 403 unauthenticated", async () => {
    const res = await post(ENTRY, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden", reason: "unauthenticated" });
    expect(h.state.puts).toHaveLength(0);
  });

  it("a signed-in human WITHOUT the admin group is 403 not_admin, nothing is written", async () => {
    seeded();
    const res = await post(ENTRY, NON_ADMIN_HEADERS);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden", reason: "not_admin" });
    expect((await del({ repo: "acme/juno" }, NON_ADMIN_HEADERS)).status).toBe(403);
    expect(h.state.puts).toHaveLength(0);
  });

  it("a signed-in admin upserts and removes; each write is logged with who did it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const up = await post(ENTRY);
      expect(up.status).toBe(200);
      expect(h.state.puts).toHaveLength(1);
      const rm = await del({ repo: "acme/juno" });
      expect(rm.status).toBe(200);
      expect(await rm.json()).toMatchObject({ ok: true, removed: true });
      expect(h.state.puts).toHaveLength(2);
      const events = log.mock.calls.map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } }).filter(Boolean);
      expect(events).toContainEqual({ event: "cd_registry_write", op: "upsert", repo: "acme/juno", by: "admin@example.com" });
      expect(events).toContainEqual({ event: "cd_registry_write", op: "remove", repo: "acme/juno", by: "admin@example.com" });
    } finally {
      log.mockRestore();
    }
  });

  it("GET is unchanged: readable with no identity at all", async () => {
    seeded();
    const res = await GET(new NextRequest("http://localhost/api/workflow/cd-registry?repo=acme/juno"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: "acme/juno", registered: true, mode: "cd" });
  });
});
