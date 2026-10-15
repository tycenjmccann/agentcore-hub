/**
 * TEAM-6347 (ship review R2-F2 on TEAM-6322 / PR #1001) — a /setup re-run that
 * brings a NEW JIRA_WEBHOOK_SECRET must configure Jira before the hub redeploy.
 *
 * Root cause: skills/setup/SKILL.md ran apply-env.sh (writes the secret to
 * .env.local), then the App Runner deploy (deploy/apprunner/deploy.sh forwards
 * the secret into the container env), and only THEN the Jira webhook step
 * (setup-jira-webhook.sh, which hands Jira the secret). Between the two, the
 * existing unsigned Jira webhook got 401 on every delivery and Jira does not
 * redeliver — the exact reversal DEPLOY.md "Jira webhook signing" forbids
 * ("Jira first (a), then the hub (b). Do not reverse it.").
 *
 * Fix: apply-env.sh prints `JIRA_WEBHOOK_SECRET_NEW=1` when the answers bring
 * a secret that differs from the on-disk one onto an existing deployment (and
 * now carries DEPLOYMENT_URL over, so the webhook script has its target), and
 * SKILL.md tells the skill to run setup-jira-webhook.sh BEFORE deploy.sh in that
 * case. DEPLOY.md documents the same order so the two stay consistent.
 *
 * Static pins, same pattern as deploy-md-jira-webhook-secret.test.ts: read the
 * file, slice the section, regex. No AWS, no network. SETUP_SKILL_MD / DEPLOY_MD
 * env overrides exist for the fail-on-base demo (`git show <base>:<file>`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const skill = readFileSync(process.env.SETUP_SKILL_MD ?? join(REPO_ROOT, "skills", "setup", "SKILL.md"), "utf8");
const deployMd = readFileSync(process.env.DEPLOY_MD ?? join(REPO_ROOT, "DEPLOY.md"), "utf8");

const MARKER = "JIRA_WEBHOOK_SECRET_NEW=1";
const ROTATING = "JIRA_WEBHOOK_SECRET_ROTATING=1";

/** Text from the first line matching `heading` up to the next `## ` heading. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  expect(start, `heading ${heading} missing`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The sentence (…up to the next period-space or newline) containing `needle`. */
function sentenceWith(text: string, needle: string): string {
  const at = text.indexOf(needle);
  expect(at, `"${needle}" missing`).toBeGreaterThan(-1);
  const start = text.lastIndexOf("\n", at) + 1;
  const endRel = text.slice(at).search(/\.(\s|$)/);
  return text.slice(start, endRel === -1 ? undefined : at + endRel + 1);
}

describe("DEPLOY.md 'Jira webhook signing' states the Jira-first order and the /setup re-run rule (TEAM-6347)", () => {
  const sec = section(deployMd, /^## Jira webhook signing/m);

  it("keeps the Jira-first mandate (TEAM-6333)", () => {
    expect(sec).toMatch(/Jira first \(a\), then the hub \(b\)\. Do not reverse it\./);
  });

  it("documents the JIRA_WEBHOOK_SECRET_NEW=1 marker with setup-jira-webhook.sh before deploy.sh", () => {
    const s = sentenceWith(sec, MARKER);
    const webhookAt = s.indexOf("setup-jira-webhook.sh");
    const deployAt = s.indexOf("deploy.sh", webhookAt + 1);
    expect(webhookAt, s).toBeGreaterThan(-1);
    expect(deployAt, s).toBeGreaterThan(webhookAt);
  });

  it("names jira.disable_webhook_signing as the explicit way to drop the secret on a re-run", () => {
    expect(sec).toMatch(/disable_webhook_signing/);
  });
});

describe("skills/setup/SKILL.md runs the Jira webhook step before the hub redeploy when the secret is new (TEAM-6347)", () => {
  it("Q3 no longer promises a plain override only — it names the disable flag and the module-independent carry-over", () => {
    const q3 = section(skill, /^## Q3 — Ticket store/m);
    expect(q3).toMatch(/disable_webhook_signing/);
    expect(q3).toMatch(/regardless of which modules or ticket provider/);
  });

  it("the apply step tells the skill to watch for the marker", () => {
    const apply = section(skill, /^## After confirmation: write `\.env\.local`/m);
    expect(apply).toContain(MARKER);
  });

  it("the deploy-target step places setup-jira-webhook.sh before deploy/apprunner/deploy.sh in the new-secret instruction, citing DEPLOY.md", () => {
    const step = section(skill, /^## Deploy target step/m);
    const markerAt = step.indexOf(MARKER);
    expect(markerAt, "marker instruction missing from the deploy-target step").toBeGreaterThan(-1);
    const after = step.slice(markerAt);
    const webhookAt = after.indexOf("./deploy/apprunner/setup-jira-webhook.sh");
    const deployAt = after.indexOf("./deploy/apprunner/deploy.sh");
    expect(webhookAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(webhookAt).toBeLessThan(deployAt);
    expect(sentenceWith(after, "./deploy/apprunner/setup-jira-webhook.sh")).toMatch(/BEFORE/);
    expect(after).toMatch(/DEPLOY\.md/);
    expect(after).toMatch(/Jira first/);
  });

  it("the post-deploy webhook step is still there for first installs and unchanged secrets (idempotent re-run)", () => {
    const step = section(skill, /^## Deploy target step/m);
    expect(step).toMatch(/^### Jira webhook setup/m);
  });
});

/**
 * TEAM-6352 (R3-F2): rotating an already-enabled secret is NOT Jira-first —
 * with one hub key that 401s every delivery until the hub redeploys. The
 * ROTATING=1 marker routes the skill hub-first (both keys), then Jira, then
 * drops JIRA_WEBHOOK_SECRET_PREVIOUS; DEPLOY.md documents the same order.
 */
describe("staged rotation order: hub (both keys) → Jira → drop PREVIOUS (TEAM-6352)", () => {
  const sec = section(deployMd, /^## Jira webhook signing/m);

  it("DEPLOY.md has a rotation bullet: both keys on the hub, then Jira, then remove PREVIOUS", () => {
    const at = sec.indexOf("**Rotating an enabled secret");
    expect(at, "rotation bullet missing").toBeGreaterThan(-1);
    const rot = sec.slice(at);
    const bothAt = rot.search(/set-env\.sh JIRA_WEBHOOK_SECRET=<new> JIRA_WEBHOOK_SECRET_PREVIOUS=<old>/);
    const jiraAt = rot.indexOf("setup-jira-webhook.sh");
    const dropAt = rot.search(/--unset JIRA_WEBHOOK_SECRET_PREVIOUS/);
    expect(bothAt).toBeGreaterThan(-1);
    expect(jiraAt).toBeGreaterThan(bothAt);
    expect(dropAt).toBeGreaterThan(jiraAt);
    expect(rot).toMatch(/on its own enables nothing/);
  });

  it("DEPLOY.md's /setup bullet routes ROTATING=1 through deploy.sh before setup-jira-webhook.sh", () => {
    const s = sentenceWith(sec, ROTATING);
    const after = sec.slice(sec.indexOf(ROTATING));
    const deployAt = after.indexOf("deploy.sh");
    const webhookAt = after.indexOf("setup-jira-webhook.sh");
    expect(s).toBeTruthy();
    expect(deployAt).toBeGreaterThan(-1);
    expect(webhookAt).toBeGreaterThan(deployAt);
  });

  it("SKILL.md apply step watches for the ROTATING marker", () => {
    const apply = section(skill, /^## After confirmation: write `\.env\.local`/m);
    expect(apply).toContain(ROTATING);
  });

  it("SKILL.md deploy-target step: ROTATING=1 runs deploy.sh FIRST, then setup-jira-webhook.sh, then drops PREVIOUS", () => {
    const step = section(skill, /^## Deploy target step/m);
    const at = step.indexOf(ROTATING);
    expect(at, "ROTATING instruction missing from the deploy-target step").toBeGreaterThan(-1);
    const after = step.slice(at);
    const deployAt = after.indexOf("./deploy/apprunner/deploy.sh");
    const webhookAt = after.indexOf("./deploy/apprunner/setup-jira-webhook.sh");
    const dropAt = after.indexOf("JIRA_WEBHOOK_SECRET_PREVIOUS");
    expect(deployAt).toBeGreaterThan(-1);
    expect(webhookAt).toBeGreaterThan(deployAt);
    expect(dropAt).toBeGreaterThan(webhookAt);
    expect(after).toMatch(/DEPLOY\.md/);
  });
});
