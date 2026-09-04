#!/usr/bin/env node
/**
 * restore-harness.mjs — roll a harness back to the snapshot harness-snapshot.mjs
 * took before the Deploy stage updated it. Called by rollback.sh for every
 * $HARNESS_SNAPSHOT_DIR/*.json when a deploy fails after a harness update.
 *
 *   node deploy/pipeline/restore-harness.mjs /tmp/rollback/harness/<name>.json
 *
 * Restores exactly what the pipeline is allowed to change (model, system
 * prompt, skills, maxTokens) — nothing else on the harness is touched.
 */
import { readFileSync } from "node:fs";
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
  UpdateHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

const file = process.argv[2];
if (!file) {
  console.error("usage: restore-harness.mjs <snapshot.json>");
  process.exit(2);
}
const snap = JSON.parse(readFileSync(file, "utf8"));
const region = process.env.AWS_REGION_HUB || process.env.AWS_REGION || "us-east-1";
const agentcore = new BedrockAgentCoreControlClient({ region });

const update = { harnessId: snap.harnessId };
if (snap.model) update.model = snap.model;
if (snap.systemPrompt) update.systemPrompt = snap.systemPrompt;
if (snap.skills) update.skills = snap.skills;
if (snap.maxTokens) update.maxTokens = snap.maxTokens;

console.log(`restoring harness ${snap.harnessName} (${snap.harnessId}) from ${snap.capturedAt}`);
await agentcore.send(new UpdateHarnessCommand(update));
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const { harness } = await agentcore.send(new GetHarnessCommand({ harnessId: snap.harnessId }));
  if (harness?.status === "READY") {
    console.log(`${snap.harnessName} restored — READY`);
    process.exit(0);
  }
  if (harness?.status === "UPDATE_FAILED") {
    console.error(`${snap.harnessName} restore FAILED: ${harness?.failureReason || "unknown"}`);
    process.exit(1);
  }
}
console.error(`${snap.harnessName}: timed out waiting for READY after restore`);
process.exit(1);
