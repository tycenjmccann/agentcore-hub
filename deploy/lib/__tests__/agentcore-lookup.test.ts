import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Unit tests for deploy/lib/agentcore-lookup.sh (TEAM-5173 r5-F1).
 *
 * Hermetic like the rest of this suite: the helper runs in a bash subprocess
 * with a PATH-shimmed fake `aws` that serves list-agent-runtimes / list-harnesses
 * one page at a time from fixture files keyed by --next-token. The shim refuses
 * the shape the helper replaces (`--query ... --output text`, auto-pagination),
 * because under --output text the AWS CLI applies --query to EACH page and a
 * two-page account printed "None\n<id>" — the bug this helper exists to end.
 */

const SCRIPT = resolve(__dirname, "../agentcore-lookup.sh");

const AWS_SHIM = `#!/bin/bash
SB="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$SB/aws-calls.log"
[[ "$1" == bedrock-agentcore-control ]] || { echo "shim: unexpected service $1" >&2; exit 90; }
op="$2"; shift 2
[[ -f "$SB/fail" ]] && { echo "An error occurred (AccessDeniedException) when calling the $op operation" >&2; exit 255; }
fmt=""; nopag=0; tok=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) fmt="$2"; shift 2 ;;
    --no-paginate) nopag=1; shift ;;
    --next-token) tok="$2"; shift 2 ;;
    --region) shift 2 ;;
    --query) echo "shim: --query is the per-page text bug" >&2; exit 97 ;;
    *) shift ;;
  esac
done
[[ "$fmt" == json && "$nopag" -eq 1 ]] || { echo "shim: need --output json --no-paginate" >&2; exit 98; }
page="$SB/pages/$op.\${tok:-page1}.json"
[[ -f "$page" ]] || { echo "shim: no page '\${tok:-page1}' for $op" >&2; exit 99; }
cat "$page"
`;

type Pages = Record<string, unknown>;

function sandbox({ runtimes = {}, harnesses = {}, fail = false, rawPages = {} }: {
  runtimes?: Pages; harnesses?: Pages; fail?: boolean; rawPages?: Record<string, string>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-lookup-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "pages"));
  writeFileSync(join(dir, "bin/aws"), AWS_SHIM);
  chmodSync(join(dir, "bin/aws"), 0o755);
  for (const [tok, page] of Object.entries(runtimes)) writeFileSync(join(dir, `pages/list-agent-runtimes.${tok}.json`), JSON.stringify(page));
  for (const [tok, page] of Object.entries(harnesses)) writeFileSync(join(dir, `pages/list-harnesses.${tok}.json`), JSON.stringify(page));
  for (const [name, body] of Object.entries(rawPages)) writeFileSync(join(dir, `pages/${name}.json`), body);
  if (fail) writeFileSync(join(dir, "fail"), "");
  return dir;
}

/** Runs `<fn> <args>` after sourcing the helper; returns exit code + streams. */
function lookup(dir: string, fn: string, args: string[], env: Record<string, string> = {}) {
  const cmd = `source "${SCRIPT}" && ${fn} ${args.map((a) => `'${a}'`).join(" ")}`;
  const r = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, AWS_REGION: "us-east-1", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const rt = (agentRuntimeName: string, agentRuntimeId: string) => ({
  agentRuntimeName, agentRuntimeId, agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${agentRuntimeId}`,
});

describe("agentcore-lookup.sh", () => {
  it("finds a runtime on the second page and prints exactly its field", () => {
    const dir = sandbox({
      runtimes: {
        page1: { agentRuntimes: [rt("agentcore_hub_other", "other1")], nextToken: "p2" },
        p2: { agentRuntimes: [rt("agentcore_hub_coding_runtime", "abc123"), rt("agentcore_hub_coding_runtime_ec2", "ec2def")] },
      },
    });
    const id = lookup(dir, "agentcore_runtime_field", ["agentcore_hub_coding_runtime", "agentRuntimeId"]);
    expect(id).toMatchObject({ code: 0, out: "abc123\n", err: "" });
    const arn = lookup(dir, "agentcore_runtime_field", ["agentcore_hub_coding_runtime_ec2", "agentRuntimeArn"]);
    expect(arn).toMatchObject({ code: 0, out: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/ec2def\n" });
  });

  it("walks every page before deciding a name is absent (rc 1, silent)", () => {
    const dir = sandbox({
      runtimes: {
        page1: { agentRuntimes: [rt("a", "1")], nextToken: "p2" },
        p2: { agentRuntimes: [rt("b", "2")], nextToken: "p3" },
        p3: { agentRuntimes: [] },
      },
    });
    const r = lookup(dir, "agentcore_runtime_field", ["missing", "agentRuntimeId"]);
    expect(r).toMatchObject({ code: 1, out: "", err: "" });
    const calls = lookup(dir, "cat", [join(dir, "aws-calls.log")]).out.trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatch(/--next-token p2/);
    expect(calls[2]).toMatch(/--next-token p3/);
  });

  it("looks harnesses up the same way", () => {
    const dir = sandbox({
      harnesses: {
        page1: { harnesses: [{ harnessName: "agentcore_hub_builder", arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/b1", harnessId: "b1" }], nextToken: "n" },
        n: { harnesses: [{ harnessName: "agentcore_hub_workflow_manager", arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/wm1", harnessId: "wm1" }] },
      },
    });
    expect(lookup(dir, "agentcore_harness_field", ["agentcore_hub_workflow_manager", "harnessId"])).toMatchObject({ code: 0, out: "wm1\n" });
    expect(lookup(dir, "agentcore_harness_field", ["agentcore_hub_builder", "arn"]).out).toBe("arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/b1\n");
  });

  it("is rc 2 with a reason when the CLI call fails — never a silent empty", () => {
    const dir = sandbox({ fail: true });
    const r = lookup(dir, "agentcore_runtime_field", ["agentcore_hub_coding_runtime", "agentRuntimeId"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/agentcore-lookup: aws list-agent-runtimes failed \(page 1\): .*AccessDeniedException/);
  });

  it("is rc 2 when a page is not JSON", () => {
    const dir = sandbox({ rawPages: { "list-agent-runtimes.page1": "None\nabc123\n" } });
    const r = lookup(dir, "agentcore_runtime_field", ["agentcore_hub_coding_runtime", "agentRuntimeId"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unusable page 1: page is not JSON/);
  });

  it("is rc 2 when the field is missing, None-like or not a plain id/ARN", () => {
    for (const bad of [undefined, "None", "", "  ", "abc\n123", "has space"]) {
      const item: Record<string, unknown> = { agentRuntimeName: "x" };
      if (bad !== undefined) item.agentRuntimeId = bad;
      const dir = sandbox({ runtimes: { page1: { agentRuntimes: [item] } } });
      const r = lookup(dir, "agentcore_runtime_field", ["x", "agentRuntimeId"]);
      expect(r.code, `value ${JSON.stringify(bad)} must be rejected`).toBe(2);
      expect(r.out).toBe("");
    }
  });

  it("is rc 2 when more than one item carries the name", () => {
    const dir = sandbox({ runtimes: { page1: { agentRuntimes: [rt("dup", "a1")], nextToken: "p2" }, p2: { agentRuntimes: [rt("dup", "a2")] } } });
    const r = lookup(dir, "agentcore_runtime_field", ["dup", "agentRuntimeId"]);
    expect(r).toMatchObject({ code: 2, out: "" });
    expect(r.err).toMatch(/more than one item named dup/);
  });

  it("is rc 2 at the page cap instead of looping forever", () => {
    const dir = sandbox({ runtimes: { page1: { agentRuntimes: [], nextToken: "page1" } } }); // self-referential token
    const r = lookup(dir, "agentcore_runtime_field", ["x", "agentRuntimeId"], { AGENTCORE_LOOKUP_MAX_PAGES: "3" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/exceeded 3 pages/);
  });

  it("is rc 2 without AWS_REGION", () => {
    const dir = sandbox();
    const r = spawnSync("bash", ["-c", `unset AWS_REGION; source "${SCRIPT}" && agentcore_runtime_field x agentRuntimeId`], {
      encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/AWS_REGION is not set/);
  });
});
