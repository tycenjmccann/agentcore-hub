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
/**
 * `heads` / `headError` back the DL-029 cd-ledger probe (TEAM-4706). The probe's
 * whole point is that a definite 404 and a failed look are DIFFERENT answers, so
 * the stub has to be able to produce each on demand: by default HeadObject
 * answers from the same object map (absent key → NotFound + 404), and a test can
 * set `h.headError` to any other AWS error to simulate the indeterminate case.
 */
const h = vi.hoisted(() => ({ puts: [], warns: [], gets: [], heads: [], headError: null, invokes: [], objects: new Map() }));

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
      if (name === "HeadObjectCommand") {
        h.heads.push(input);
        if (h.headError) throw h.headError;
        if (!h.objects.has(input.Key)) {
          const err = new Error(`Not Found: ${input.Key}`);
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { ContentLength: h.objects.get(input.Key).length };
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
  HeadObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  // The Done transition itself is not under test — a plain success keeps the log
  // quiet — but `h.invokes` records every call, because the DL-029 refusals below
  // are only meaningful if the ticket was NOT transitioned.
  LambdaClient: class {
    async send(cmd) {
      h.invokes.push(cmd?.input || {});
      return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true })) };
    }
  },
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

// TEAM-4706 fixtures, shared with the ship-report-contract block at the bottom.
const EXEC_ID = "b3a1c0de-1234-4f56-89ab-cdef01234567"; // 36 chars, [0-9a-f-] only
const PIPELINE = "hub-agentcore-hub-deploy";
const MERGE_COMMIT = "0ef5892abc";
const PR_URL = "https://github.com/owner/repo/pull/42";
/** The tool's parsed result payload (success OR refusal — both are values). */
const result = (res) => JSON.parse(res.content[0].text);
/** Did the call write a completion record at all? */
const wroteRecord = () => h.puts.some((p) => p.Key?.startsWith("completions/"));
/** Did the call ask the ticket-tools Lambda to transition the ticket? */
const transitioned = () => h.invokes.length > 0;

beforeEach(() => {
  h.puts.length = 0;
  h.warns.length = 0;
  h.gets.length = 0;
  h.heads.length = 0;
  h.invokes.length = 0;
  h.headError = null;
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
    // TEAM-4706: two of the four outcomes now have to satisfy the ship-report
    // contract (see the last describe), so each is given the fields IT requires.
    // The assertion is unchanged: all four values are accepted and normalized.
    const REQUIRED = {
      shipped: { merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID },
      "deploy-blocked": {},
      "static-ci-only": {},
      handoff: { pr_url: PR_URL },
    };
    for (const oc of ["shipped", "deploy-blocked", "static-ci-only", "handoff"]) {
      h.puts.length = 0;
      await report({ outcome: ` ${oc.toUpperCase()} `, ...REQUIRED[oc] });
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

// ─── TEAM-4706 / DL-029: the ship-report contract ─────────────────────────────
//
// `outcome:"shipped"` is the only durable claim that production changed, and the
// tool used to take it on trust — a record with no merge commit and no deploy
// execution still closed the ticket, so "we shipped" and "we never reached CD"
// were the same bytes. Now a shipped report must NAME what it shipped, and a
// handoff must name the PR it handed off; a report that cannot is refused as a
// VALUE (the agent can read the reason and act), and refusal means NOTHING is
// written and the ticket is NOT transitioned.
//
// The conditional half is where the care is. This Lambda cannot know whether the
// repo is CD-registered (no repo on the wire, no registry, no workflows table),
// and the legacy DEPLOY.md ship path legitimately ships with no pipeline
// execution at all. So the execution id is required UNLESS the run is *provably*
// legacy: no pipeline_name argument AND a definite 404 on the run's cd-ledger.
// An indeterminate S3 answer (AccessDenied, throttle, timeout) is NOT proof and
// therefore refuses — DL-028's rule, "the licence to proceed must be positive
// evidence". Refusing costs a human gate ticket; accepting silently claims a
// deploy that may never have happened.
const CD_LEDGER_KEY = "workflows/wf_1/shared/cd-ledger.json";

describe("report_completion — ship-report contract (pipeline_execution_id / pipeline_name)", () => {
  it("(1) refuses shipped with no pipeline_execution_id, writing nothing and transitioning nothing", async () => {
    // Two ways the pipeline path is known to have been used: the caller named the
    // pipeline, or the run's cd-ledger exists. Both make the id mandatory.
    const cases = [
      { pipeline_name: PIPELINE },
      { ledger: true },
    ];
    for (const c of cases) {
      h.puts.length = 0;
      h.invokes.length = 0;
      h.objects.clear();
      if (c.ledger) h.objects.set(CD_LEDGER_KEY, JSON.stringify({ execution_id: EXEC_ID }));
      const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, ...(c.pipeline_name ? { pipeline_name: PIPELINE } : {}) }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
      expect(r.missing).toEqual(["pipeline_execution_id"]);
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    }
  });

  it("(2) refuses shipped with no merge_commit, writing nothing and transitioning nothing", async () => {
    const r = result(await report({ outcome: "shipped", pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
    expect(r.missing).toEqual(["merge_commit"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("(3) accepts shipped with both, storing them and transitioning the ticket", async () => {
    const res = await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE });
    expect(result(res).status).toBe("complete");
    const r = record();
    expect(r.pipeline_execution_id).toBe(EXEC_ID);
    expect(r.pipeline_name).toBe(PIPELINE);
    expect(r.merge_commit).toBe(MERGE_COMMIT);
    expect(r.outcome).toBe("shipped");
    expect(transitioned()).toBe(true);
  });

  it("(3b) trims and lowercases an execution id, and drops an oversized pipeline_name", async () => {
    await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: `  ${EXEC_ID.toUpperCase()}  `, pipeline_name: "p".repeat(129) });
    const r = record();
    expect(r.pipeline_execution_id).toBe(EXEC_ID);
    expect("pipeline_name" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/oversized pipeline_name/);
  });

  it("(4) refuses handoff with no pr_url, transitioning nothing", async () => {
    for (const extra of [{}, { pr_url: "   " }]) {
      h.puts.length = 0;
      h.invokes.length = 0;
      const r = result(await report({ outcome: "handoff", ...extra }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("handoff_requires_pr_url");
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    }
    // …and accepts it the moment the PR exists.
    const res = await report({ outcome: "handoff", pr_url: PR_URL });
    expect(result(res).status).toBe("complete");
    expect(record().outcome).toBe("handoff");
  });

  it("(5) accepts the legacy DEPLOY.md ship: no pipeline_name, cd-ledger definitively absent", async () => {
    // THE regression that must not break: a registered repo with no CodePipeline
    // ships via DEPLOY.md and has no execution id to report, ever.
    const res = await report({ outcome: "shipped", merge_commit: MERGE_COMMIT });
    expect(result(res).status).toBe("complete");
    const r = record();
    expect(r.outcome).toBe("shipped");
    expect("pipeline_execution_id" in r).toBe(false);
    expect(transitioned()).toBe(true);
    // The licence came from a real probe, not from an assumption.
    expect(h.heads.map((x) => x.Key)).toContain(CD_LEDGER_KEY);
  });

  it("(5b) a NoSuchKey-flavoured 404 is the same positive evidence as NotFound", async () => {
    const err = new Error("The specified key does not exist.");
    err.name = "NoSuchKey";
    h.headError = err;
    expect(result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT })).status).toBe("complete");
  });

  it("(6) refuses when the cd-ledger probe is indeterminate (AccessDenied), not just when it finds a ledger", async () => {
    const err = new Error("Access Denied");
    err.name = "AccessDenied";
    err.$metadata = { httpStatusCode: 403 };
    h.headError = err;
    const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
    expect(r.missing).toEqual(["pipeline_execution_id"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/indeterminate/);
  });

  it("(7) deploy-blocked and static-ci-only still succeed, and log DEPRECATED (DL-029)", async () => {
    for (const oc of ["deploy-blocked", "static-ci-only"]) {
      h.puts.length = 0;
      h.warns.length = 0;
      h.invokes.length = 0;
      const res = await report({ outcome: oc, block_reason: "pipeline stage Deploy failed" });
      expect(result(res).status).toBe("complete");
      expect(record().outcome).toBe(oc);
      expect(transitioned()).toBe(true);
      expect(h.warns.join("\n")).toContain(`[report_completion] DEPRECATED outcome ${oc} (DL-029)`);
    }
  });

  it("(8) a malformed execution id is dropped with a warning — and for shipped that counts as missing", async () => {
    // Not stored on a non-ship report…
    await report({ pipeline_execution_id: "not-a-pipeline-execution-id" });
    expect("pipeline_execution_id" in record()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/malformed pipeline_execution_id/);
    // …and a shipped report that supplied only that is refused, because a mangled
    // id reads as proof of a deploy nobody can look up.
    h.puts.length = 0;
    h.invokes.length = 0;
    const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_name: PIPELINE, pipeline_execution_id: EXEC_ID.replace("b", "z") }));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["pipeline_execution_id"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("(9) a record written without the new fields keeps exactly the pre-4706 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    // Blank values are the same as absent — no keys, no warnings.
    h.puts.length = 0;
    h.warns.length = 0;
    await report({ pipeline_execution_id: "  ", pipeline_name: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    expect(h.warns.join("\n")).not.toMatch(/pipeline_/);
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
