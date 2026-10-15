/**
 * TEAM-6340 (doc fix on TEAM-6322/TEAM-6336) — DEPLOY.md "Jira webhook signing"
 * must not tell the operator that step (a) puts JIRA_WEBHOOK_SECRET in
 * .env.local, and step (b) must say explicitly to add it there.
 *
 * Root cause: the "Full redeploys read .env.local" bullet said "Keep the secret
 * in .env.local (step (a) already puts it there)". Neither route of (a) does:
 * the Jira-UI route never touches the file, and setup-jira-webhook.sh only
 * reads it (load_env_local). Step (b) used only set-env.sh, which writes to the
 * live ECS service. An operator following the doc as written ended with the
 * secret only on the running service — and the next full redeploy (the very
 * case the bullet warns about) dropped it, reverting /api/jira/webhook to
 * unsigned passthrough.
 *
 * Static pin, same pattern as the "static contract" block in
 * jira-webhook-secret-forward.test.ts: read the file, slice the section, regex.
 * No AWS, no network.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const text = readFileSync(join(REPO_ROOT, "DEPLOY.md"), "utf8");

/** Text from the "## Jira webhook signing" heading up to the next "## " heading. */
function section(): string {
  const start = text.search(/^## Jira webhook signing/m);
  expect(start, "section heading missing").toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The "(b) Hub side" bullet: from its bold label to the "Full redeploys" bullet. */
function stepB(sec: string): string {
  const b = sec.indexOf("**(b) Hub side.**");
  const full = sec.indexOf("**Full redeploys read `.env.local`");
  expect(b, "(b) bullet missing").toBeGreaterThan(-1);
  expect(full, "Full-redeploys bullet missing").toBeGreaterThan(b);
  return sec.slice(b, full);
}

describe("DEPLOY.md 'Jira webhook signing' — .env.local is an explicit step (b) duty (TEAM-6340)", () => {
  const sec = section();

  it("does not claim step (a) puts the secret in .env.local", () => {
    expect(sec).not.toMatch(/already puts it there/);
    expect(sec).not.toMatch(/step \(a\)[^.\n]*puts[^.\n]*\.env\.local/);
  });

  it("step (b) explicitly instructs adding JIRA_WEBHOOK_SECRET to .env.local", () => {
    const b = stepB(sec);
    expect(b).toMatch(/Add `JIRA_WEBHOOK_SECRET=<the same value>` to `\.env\.local`/);
    // The .env.local instruction must come before the set-env.sh command, so the
    // operator cannot stop after the live-service step.
    const envLocalAt = b.search(/to `\.env\.local`/);
    const setEnvAt = b.indexOf("set-env.sh JIRA_WEBHOOK_SECRET=");
    expect(setEnvAt).toBeGreaterThan(-1);
    expect(envLocalAt).toBeLessThan(setEnvAt);
  });

  it("the rollback line still tells the operator to remove the .env.local line", () => {
    expect(sec).toMatch(/--unset JIRA_WEBHOOK_SECRET`,\s*and remove the line from `\.env\.local` too/);
  });
});
