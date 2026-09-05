import { describe, it, expect } from "vitest";
import {
  isPipelineEnabled,
  parsePipelineRepos,
  normalizeRepoKey,
  pipelineOwnsRepo,
} from "./pipeline-enabled.mjs";

/**
 * TEAM-3738 (same defect class as TEAM-3723): deploy.sh forwards PIPELINE_ENABLED
 * verbatim, so a strict === "1"/"true" comparison silently disabled pipeline
 * mode on whitespace-padded or case-variant values.
 */

describe("isPipelineEnabled", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" true", true],
    ["1 ", true],
    ["True", true],
    ["0", false],
    ["", false],
    [undefined, false],
    ["false", false],
    ["yes", false],
  ])("%p -> %p", (input, expected) => {
    expect(isPipelineEnabled(input)).toBe(expected);
  });
});

/**
 * TEAM-4044: the flag is scoped by PIPELINE_REPOS. A juno run on a hub whose
 * only pipeline deploys agentcore-hub must NOT be told a pipeline owns its
 * deploy — that sent the release manager's Pipeline___* preflight to the hub's
 * pipeline and blocked CD on a phantom infra ticket.
 */
describe("normalizeRepoKey", () => {
  it.each([
    ["tycenjmccann/agentcore-hub", "tycenjmccann/agentcore-hub"],
    ["TycenJMcCann/AgentCore-Hub", "tycenjmccann/agentcore-hub"],
    ["https://github.com/tycenjmccann/juno.git", "tycenjmccann/juno"],
    ["https://github.com/tycenjmccann/juno", "tycenjmccann/juno"],
    ["git@github.com:tycenjmccann/juno.git", "tycenjmccann/juno"],
    ["  owner/repo  ", "owner/repo"],
    ["", null],
    [undefined, null],
    ["just-a-name", null],
    ["a/b/c", null],
  ])("%p -> %p", (input, expected) => {
    expect(normalizeRepoKey(input)).toBe(expected);
  });
});

describe("parsePipelineRepos", () => {
  it("splits on commas and whitespace, normalizes, dedupes, drops junk", () => {
    const set = parsePipelineRepos(
      " tycenjmccann/agentcore-hub, https://github.com/Tycenjmccann/AgentCore-Hub.git\nacme/widgets ,, not-a-repo"
    );
    expect([...set].sort()).toEqual(["acme/widgets", "tycenjmccann/agentcore-hub"]);
  });
  it("empty / unset → empty scope", () => {
    expect(parsePipelineRepos("").size).toBe(0);
    expect(parsePipelineRepos(undefined).size).toBe(0);
    expect(parsePipelineRepos(" , ").size).toBe(0);
  });
});

describe("pipelineOwnsRepo", () => {
  const hub = { repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub.git" }] };
  const juno = { repos: [{ url: "https://github.com/tycenjmccann/juno.git" }] };

  it("unscoped (PIPELINE_REPOS unset/empty) → every repo is pipeline-owned (legacy)", () => {
    expect(pipelineOwnsRepo(hub, undefined)).toBe(true);
    expect(pipelineOwnsRepo(juno, "")).toBe(true);
    expect(pipelineOwnsRepo(undefined, undefined)).toBe(true);
  });

  it("scoped → only the listed repo is pipeline-owned", () => {
    const scope = "tycenjmccann/agentcore-hub";
    expect(pipelineOwnsRepo(hub, scope)).toBe(true);
    expect(pipelineOwnsRepo(juno, scope)).toBe(false);
  });

  it("scoped matching is case-insensitive and URL-form-agnostic", () => {
    expect(pipelineOwnsRepo(hub, "https://github.com/TYCENJMCCANN/AGENTCORE-HUB")).toBe(true);
    expect(pipelineOwnsRepo({ repos: [{ url: "git@github.com:tycenjmccann/agentcore-hub.git" }] }, "tycenjmccann/agentcore-hub")).toBe(true);
  });

  it("scoped + run without a repo URL → not pipeline-owned", () => {
    expect(pipelineOwnsRepo(undefined, "tycenjmccann/agentcore-hub")).toBe(false);
    expect(pipelineOwnsRepo({ repos: [] }, "tycenjmccann/agentcore-hub")).toBe(false);
    expect(pipelineOwnsRepo({ repos: [{ url: "" }] }, "tycenjmccann/agentcore-hub")).toBe(false);
  });
});
