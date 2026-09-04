/**
 * harness-snapshot.mjs — capture a harness's live prompt/model/skills before the
 * pipeline's Deploy stage rewrites them, so rollback.sh can restore them.
 *
 * Used by the three harness setup scripts when PIPELINE_MODE=1 (the Deploy
 * stage). Writes $HARNESS_SNAPSHOT_DIR/<harnessName>.json — the same shape
 * restore-harness.mjs feeds back to UpdateHarness. A missing
 * HARNESS_SNAPSHOT_DIR means "not in the pipeline": no-op.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function snapshotHarness(agentcore, GetHarnessCommand, harnessId, harnessName) {
  const dir = process.env.HARNESS_SNAPSHOT_DIR;
  if (!dir) return null;
  const { harness } = await agentcore.send(new GetHarnessCommand({ harnessId }));
  const snap = {
    harnessId,
    harnessName,
    capturedAt: new Date().toISOString(),
    model: harness?.model,
    systemPrompt: harness?.systemPrompt,
    skills: harness?.skills,
    maxTokens: harness?.maxTokens,
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${harnessName}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`   snapshot: ${file} (model=${snap.model?.bedrockModelConfig?.modelId || snap.model?.openAiModelConfig?.modelId || "?"})`);
  return file;
}
