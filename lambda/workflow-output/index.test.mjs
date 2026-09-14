import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * report_completion's completion RECORD (TEAM-4121 FR-9).
 *
 * completions/<ticket>.json is the only durable statement of how an agent knows
 * its work is done, and the orchestrator now acts on it: a fix ticket that
 * declared evidence_source=live but whose record carries no live evidence is
 * marked `unverified` and re-verified at the PR head (live-reverify.mjs). So the
 * two new fields have to be BOTH additive — a record written without them must
 * keep exactly the pre-4121 key set, or every existing consumer changes shape at
 * once — and closed: an unrecognized evidence_kind is dropped rather than stored,
 * because a downstream reader must never have to guess what a novel value meant.
 */

/**
 * save_design_doc's by-reference path (TEAM-4589) is also covered here, which is
 * why the S3 mock below is backed by an in-test object map rather than returning
 * a bare {}: reading a doc by key, the shared/ dedupe listing and the manifest
 * round-trip are all the SAME bucket, so a test that writes then re-saves has to
 * see its own bytes. `h.puts` still records PutObjectCommand inputs verbatim, so
 * every report_completion assertion above/below is untouched by the redesign.
 */
const h = vi.hoisted(() => ({ puts: [], warns: [], gets: [], objects: new Map() }));

const asString = (body) => (typeof body === "string" ? body : Buffer.from(body).toString("utf8"));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd?.constructor?.name;
      const input = cmd?.input || {};
      if (name === "PutObjectCommand") {
        h.puts.push(input);
        h.objects.set(input.Key, asString(input.Body));
        return {};
      }
      if (name === "GetObjectCommand") {
        h.gets.push(input);
        if (!h.objects.has(input.Key)) {
          // Real S3 surfaces a missing object this way, and the Lambda's error
          // message quotes err.name — so the stub has to carry the same name.
          const err = new Error(`The specified key does not exist: ${input.Key}`);
          err.name = "NoSuchKey";
          throw err;
        }
        const body = h.objects.get(input.Key);
        return {
          ContentType: "text/markdown",
          Body: {
            transformToString: async () => body,
            transformToByteArray: async () => Buffer.from(body),
          },
        };
      }
      if (name === "ListObjectsV2Command") {
        const prefix = input.Prefix || "";
        return {
          Contents: [...h.objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ Key: k, Size: h.objects.get(k).length, LastModified: new Date(0) })),
        };
      }
      return {};
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  // The Done transition is not under test; a plain success keeps the log quiet.
  LambdaClient: class { async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true })) }; } },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
const { handler, inferToolFromArgs } = await import("./index.mjs");

/** The completion record the call wrote, parsed. */
const record = () => JSON.parse(h.puts.find((p) => p.Key?.startsWith("completions/")).Body);

const report = (extra) =>
  handler({
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: "TEAM-4200",
      summary: "Re-ran the expired-token repro at HEAD; 401 as expected.",
      workflow_id: "wf_1",
      agent_id: "agentcore_hub_qa_verifier",
      ...extra,
    },
  });

// Every key a pre-4121 record carries — asserted as a SET so an accidental
// addition (or rename) fails here rather than in whatever reads the record.
const BASE_KEYS = ["ticket_id", "summary", "artifacts", "branch", "commit_sha", "pr_url", "completed_at"];

beforeEach(() => {
  h.puts.length = 0;
  h.warns.length = 0;
  h.gets.length = 0;
  h.objects.clear();
  vi.spyOn(console, "warn").mockImplementation((...args) => h.warns.push(args.join(" ")));
});

describe("report_completion — evidence_kind / evidence_keys", () => {
  it("persists both when the agent supplies them", async () => {
    await report({ evidence_kind: "live", evidence_keys: "workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log" });
    const r = record();
    expect(r.evidence_kind).toBe("live");
    expect(r.evidence_keys).toBe("workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log");
  });

  it("a record written without them keeps exactly the pre-4121 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("blank values are the same as absent", async () => {
    await report({ evidence_kind: "   ", evidence_keys: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("normalizes case and whitespace", async () => {
    await report({ evidence_kind: " LIVE " });
    expect(record().evidence_kind).toBe("live");
  });

  it("accepts the other two kinds", async () => {
    await report({ evidence_kind: "static" });
    expect(record().evidence_kind).toBe("static");
    h.puts.length = 0;
    await report({ evidence_kind: "unit" });
    expect(record().evidence_kind).toBe("unit");
  });

  it("drops an unknown kind with a warning instead of storing it", async () => {
    await report({ evidence_kind: "vibes", evidence_keys: "qa-evidence/a.png" });
    const r = record();
    expect("evidence_kind" in r).toBe(false);
    // The keys still land — they are the weaker signal, but they are real.
    expect(r.evidence_keys).toBe("qa-evidence/a.png");
    expect(h.warns.join("\n")).toMatch(/unknown evidence_kind "vibes"/);
  });

  it("accepts an array of keys (the harness sends a comma string; a gateway may not)", async () => {
    await report({ evidence_kind: "live", evidence_keys: ["qa-evidence/a.png", "qa-evidence/b.har"] });
    expect(record().evidence_keys).toBe("qa-evidence/a.png,qa-evidence/b.har");
  });
});

// TEAM-4122 FR-4 §7.5 — the CI agent's proof that a head SHA was actually built,
// same additive-and-closed contract as evidence_kind above.
describe("report_completion — ci_status / ci_build_id / ci_head_sha", () => {
  it("persists all three when the CI agent supplies them", async () => {
    await report({ ci_status: "certified", ci_build_id: "agentcore-hub-ci:abc123", ci_head_sha: "deadbeef" });
    const r = record();
    expect(r.ci_status).toBe("certified");
    expect(r.ci_build_id).toBe("agentcore-hub-ci:abc123");
    expect(r.ci_head_sha).toBe("deadbeef");
  });

  it("a record written without them keeps exactly the pre-4122 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("accepts the other two statuses and normalizes case/whitespace", async () => {
    await report({ ci_status: "  GITHUB-ACTIONS-PROXY  " });
    expect(record().ci_status).toBe("github-actions-proxy");
    h.puts.length = 0;
    await report({ ci_status: "unverified" });
    expect(record().ci_status).toBe("unverified");
  });

  it("drops an unknown status with a warning instead of storing it", async () => {
    await report({ ci_status: "definitely-passed", ci_build_id: "abc123" });
    const r = record();
    expect("ci_status" in r).toBe(false);
    // The build id still lands — it's the weaker signal, but it's real.
    expect(r.ci_build_id).toBe("abc123");
    expect(h.warns.join("\n")).toMatch(/unknown ci_status "definitely-passed"/);
  });

  it("drops an oversized build id / head sha with a warning instead of storing it", async () => {
    await report({ ci_build_id: "x".repeat(129), ci_head_sha: "y".repeat(129) });
    const r = record();
    expect("ci_build_id" in r).toBe(false);
    expect("ci_head_sha" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/oversized ci_build_id/);
    expect(h.warns.join("\n")).toMatch(/oversized ci_head_sha/);
  });
});

// DL-024 / ship verdict — the release manager's CD ticket reports how the run
// ended. The orchestrator's completion evidence harvest already reads these
// keys (completion.mjs SHIP_BLOCKED_OUTCOMES); same additive-and-closed contract.
describe("report_completion — merge_commit / outcome / block_reason", () => {
  it("persists all three when the release manager supplies them", async () => {
    await report({ merge_commit: "0ef5892abc", outcome: "shipped", block_reason: "" });
    const r = record();
    expect(r.merge_commit).toBe("0ef5892abc");
    expect(r.outcome).toBe("shipped");
    expect("block_reason" in r).toBe(false);
  });

  it("a record written without them keeps exactly the base key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("normalizes outcome case/whitespace and accepts every allowed value", async () => {
    for (const oc of ["shipped", "deploy-blocked", "static-ci-only", "handoff"]) {
      h.puts.length = 0;
      await report({ outcome: ` ${oc.toUpperCase()} ` });
      expect(record().outcome).toBe(oc);
    }
  });

  it("drops an unknown outcome with a warning but keeps block_reason", async () => {
    await report({ outcome: "kinda-shipped", block_reason: "pipeline stage Deploy failed" });
    const r = record();
    expect("outcome" in r).toBe(false);
    expect(r.block_reason).toBe("pipeline stage Deploy failed");
    expect(h.warns.join("\n")).toMatch(/unknown outcome "kinda-shipped"/);
  });

  it("clips block_reason to 500 chars and drops an oversized merge_commit", async () => {
    await report({ merge_commit: "x".repeat(129), block_reason: "y".repeat(600) });
    const r = record();
    expect("merge_commit" in r).toBe(false);
    expect(r.block_reason).toHaveLength(500);
    expect(h.warns.join("\n")).toMatch(/oversized merge_commit/);
  });
});

// TEAM-4525 AC-3 — the head SHA a human approved at the Merge Approval gate is
// recorded on the ship record, so the deploy gate's "is this the merge of what a
// human approved?" question has a durable answer. Same additive contract as
// merge_commit, but stricter: anything that is not a full 40-hex git SHA is
// dropped, because a half-recorded SHA would be read as an approval it isn't.
describe("report_completion — approved_head_sha", () => {
  const SHA = "1f0c3b8ad4e5f60718293a4b5c6d7e8f90a1b2c3";

  it("persists a valid 40-hex sha alongside merge_commit", async () => {
    await report({ approved_head_sha: SHA, merge_commit: "0ef5892abc", outcome: "shipped" });
    const r = record();
    expect(r.approved_head_sha).toBe(SHA);
    expect(r.merge_commit).toBe("0ef5892abc");
  });

  it("trims and lowercases", async () => {
    await report({ approved_head_sha: `  ${SHA.toUpperCase()}  ` });
    expect(record().approved_head_sha).toBe(SHA);
  });

  it("drops a value that is not a git sha with a warning", async () => {
    await report({ approved_head_sha: "abc", merge_commit: "0ef5892abc" });
    const r = record();
    expect("approved_head_sha" in r).toBe(false);
    // The merge commit still lands — the malformed field is dropped alone.
    expect(r.merge_commit).toBe("0ef5892abc");
    expect(h.warns.join("\n")).toMatch(/malformed approved_head_sha/);
  });

  it("drops an oversized value with a warning", async () => {
    await report({ approved_head_sha: "a".repeat(129) });
    expect("approved_head_sha" in record()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/malformed approved_head_sha/);
  });

  it("an absent value produces no key at all", async () => {
    await report({});
    const r = record();
    expect("approved_head_sha" in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("a blank value is the same as absent — no key, no warning", async () => {
    await report({ approved_head_sha: "   " });
    expect("approved_head_sha" in record()).toBe(false);
    expect(h.warns.join("\n")).not.toMatch(/approved_head_sha/);
  });
});

// ─── TEAM-4589: save_design_doc pass-by-reference ─────────────────────────────
//
// The doc used to reach this tool only as an inline `content` string, so an agent
// had to re-emit the whole document as a tool argument. A 97 KB design doc killed
// backend_designer with MaxTokensReachedException four times — on a document that
// was ALREADY in S3. So `s3Key` lets the agent register bytes it already wrote.
//
// Two properties carry the weight. (1) Nothing may be written before the key
// validates and the GET succeeds: a half-saved doc leaves a critical:true
// manifest entry pointing at garbage, which silently poisons every downstream
// reader, whereas a hard error just strands a recoverable ticket. (2) The inline
// path must be untouched — same writes, same response key set — because every
// small-doc caller still uses it.

const WF = "wf_1";
const DESIGNER = "agentcore_hub_backend_designer";
// The destination keys saveDesignDoc computes for that agent (no title/format is
// sent by main.py, so the slug is deterministic).
const DEST = `workflows/${WF}/${DESIGNER}/design-doc-${DESIGNER}.md`;
const SHARED_DEST = `workflows/${WF}/shared/design-doc-${DESIGNER}.md`;
// Where a designer stages a large doc per its blueprint: its OWN agent_id folder,
// deliberately NOT shared/ — a staging file under shared/ would be picked up by
// this tool's own dup-doc listing and reported back as a rival design doc.
const STAGED = `workflows/${WF}/${DESIGNER}/backend-design.md`;
const BIG_DOC = `# Backend design\n\n${"Section body.\n".repeat(50)}`;

const saveDoc = (args) =>
  handler({
    tool_name: "WorkflowOutput___save_design_doc",
    arguments: { workflow_id: WF, agent_id: DESIGNER, ...args },
  });

/** The tool's parsed success payload. */
const saved = (res) => JSON.parse(res.content[0].text);
const errorText = (res) => res.content[0].text;
/** Bodies written to the two destination keys, in write order. */
const written = (key) => h.puts.filter((p) => p.Key === key).map((p) => p.Body);
/** Design-doc entries the manifest's design phase carries after the last write. */
const manifestDesignEntries = () => {
  const put = [...h.puts].reverse().find((p) => p.Key === `workflows/${WF}/shared/manifest.json`);
  if (!put) return [];
  return (JSON.parse(put.Body).phases.design || []).filter((e) => e.type === "design-doc");
};

// The exact response key set an inline save returned before TEAM-4589.
const PRE_4589_RESPONSE_KEYS = ["status", "location", "shared_location", "existing_design_docs", "message"];

describe("save_design_doc — s3Key reads the doc instead of taking it inline", () => {
  it("(a) writes BOTH destination keys with the source object's body", async () => {
    h.objects.set(STAGED, BIG_DOC);
    await saveDoc({ s3Key: STAGED });
    expect(written(DEST)).toEqual([BIG_DOC]);
    expect(written(SHARED_DEST)).toEqual([BIG_DOC]);
    // The source is registered, never consumed — no delete, no move.
    expect(h.objects.get(STAGED)).toBe(BIG_DOC);
  });

  it("(b) returns the five pre-change keys plus source_s3_key", async () => {
    h.objects.set(STAGED, BIG_DOC);
    const r = saved(await saveDoc({ s3Key: STAGED }));
    expect(Object.keys(r).sort()).toEqual([...PRE_4589_RESPONSE_KEYS, "source_s3_key"].sort());
    expect(r.source_s3_key).toBe(STAGED);
    expect(r.status).toBe("saved");
    expect(r.location).toBe(`s3://test-bucket/${DEST}`);
    expect(r.shared_location).toBe(`s3://test-bucket/${SHARED_DEST}`);
    expect(r.existing_design_docs).toEqual([]);
  });

  it("(c) registers ONE critical manifest entry, and a re-save adds no second one", async () => {
    h.objects.set(STAGED, BIG_DOC);
    await saveDoc({ s3Key: STAGED });
    const entries = manifestDesignEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].critical).toBe(true);
    // The entry must point at the SHARED copy — that is the key downstream
    // agents are handed in their context, not the per-agent one.
    expect(entries[0].s3Key).toBe(SHARED_DEST);

    // Re-save over the doc that now exists in shared/: an update in place, and
    // crucially not a duplicate ★ entry in the next phase's prompt.
    h.puts.length = 0;
    h.objects.set(STAGED, `${BIG_DOC}\n## Revised\n`);
    const r = saved(await saveDoc({ s3Key: STAGED }));
    expect(r.status).toBe("updated");
    expect(manifestDesignEntries()).toHaveLength(0); // no manifest write at all
    expect(written(SHARED_DEST)).toEqual([`${BIG_DOC}\n## Revised\n`]);
  });

  it("(d) both supplied: s3Key wins, content is ignored, and a warning says so", async () => {
    h.objects.set(STAGED, BIG_DOC);
    const res = await saveDoc({ s3Key: STAGED, content: "# The stale inline copy\n" });
    expect(res.isError).toBeFalsy();
    expect(written(SHARED_DEST)).toEqual([BIG_DOC]);
    expect(h.warns.join("\n")).toMatch(/both content and s3Key/);
    expect(h.warns.join("\n")).toMatch(/precedence/);
    expect(saved(res).source_s3_key).toBe(STAGED);
  });

  it("(e) neither, and both blank, is an error that writes nothing", async () => {
    for (const args of [{}, { content: "", s3Key: "" }, { content: "   ", s3Key: "  \n " }]) {
      h.puts.length = 0;
      const res = await saveDoc(args);
      expect(res.isError).toBe(true);
      expect(errorText(res)).toMatch(/content or s3Key is required/);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(f) a missing object names the key and writes nothing", async () => {
    const res = await saveDoc({ s3Key: STAGED });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain(STAGED);
    expect(errorText(res)).toMatch(/NoSuchKey/);
    expect(h.puts).toHaveLength(0);
  });

  it("(g) an empty or whitespace-only object names the key and writes nothing", async () => {
    for (const body of ["", "   \n\t  "]) {
      h.puts.length = 0;
      h.objects.set(STAGED, body);
      const res = await saveDoc({ s3Key: STAGED });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain(STAGED);
      expect(errorText(res)).toMatch(/empty/);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(h) the footgun guard rejects a malformed key with zero reads and zero writes", async () => {
    const rejected = [
      [`s3://bucket/workflows/${WF}/x.md`, /s3:\/\/ URL/],
      [`/workflows/${WF}/x.md`, /starts with/],
      [`workflows/${WF}/../../secrets.md`, /path segment/],
      ["blueprints/backend-designer.md", /outside the workflows\/ prefix/],
    ];
    for (const [key, why] of rejected) {
      h.puts.length = 0;
      h.gets.length = 0;
      const res = await saveDoc({ s3Key: key });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain(key);
      expect(errorText(res)).toMatch(why);
      // Names the expected shape, not just the rejection.
      expect(errorText(res)).toMatch(/plain object key under workflows\//);
      expect(h.gets).toHaveLength(0);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(h2) an invalid key never falls back to the inline content", async () => {
    const res = await saveDoc({ s3Key: "/etc/passwd", content: "# a perfectly good doc\n" });
    expect(res.isError).toBe(true);
    expect(h.puts).toHaveLength(0);
  });

  it("(i) the inline path is unchanged — both keys written, no source_s3_key", async () => {
    const res = await saveDoc({ content: "# Small design\n\nOne paragraph.\n" });
    expect(written(DEST)).toEqual(["# Small design\n\nOne paragraph.\n"]);
    expect(written(SHARED_DEST)).toEqual(["# Small design\n\nOne paragraph.\n"]);
    const r = saved(res);
    expect(Object.keys(r).sort()).toEqual([...PRE_4589_RESPONSE_KEYS].sort());
    expect("source_s3_key" in r).toBe(false);
    expect(h.gets.some((g) => g.Key === STAGED)).toBe(false);
  });

  it("format decides the extension — never the source key's", async () => {
    // A doc staged as .json but registered as markdown is stored as the markdown
    // the caller declared. Inferring from the source key would rename the file
    // and change its ContentType behind the caller's back.
    const jsonStaged = `workflows/${WF}/${DESIGNER}/spec.json`;
    h.objects.set(jsonStaged, '{"ok":true}');
    await saveDoc({ s3Key: jsonStaged });
    expect(written(SHARED_DEST)).toEqual(['{"ok":true}']);
    expect(h.puts.find((p) => p.Key === SHARED_DEST).ContentType).toBe("text/markdown");
  });
});

describe("inferToolFromArgs — (j) flat-args routing", () => {
  it("routes a by-reference save with no content at all", () => {
    expect(inferToolFromArgs({ s3Key: STAGED, workflow_id: WF, agent_id: DESIGNER })).toBe("save_design_doc");
  });

  // Every pre-4589 outcome, asserted so the new rule cannot have shadowed one.
  it("keeps every existing rule's outcome", () => {
    expect(inferToolFromArgs({ ticket_id: "TEAM-1", summary: "done" })).toBe("report_completion");
    expect(inferToolFromArgs({ content: "# doc", workflow_id: WF })).toBe("save_design_doc");
    expect(inferToolFromArgs({ requirements: "r", tickets: "[]" })).toBe("submit_ticket_plan");
    expect(inferToolFromArgs({ tickets: "[]" })).toBe("submit_ticket_plan");
    expect(inferToolFromArgs({ title: "T", content: "# doc", agent_id: DESIGNER })).toBe("save_design_doc");
    expect(inferToolFromArgs({ nothing: "useful" })).toBe(null);
  });
});
