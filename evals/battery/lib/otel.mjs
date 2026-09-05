// OTEL GenAI evaluation attribute keys. Source of truth is
// lambda/eval-packager/index.mjs (attrs['gen_ai.evaluation.*'] reads); the
// contract fixture schema/otel-eval-attributes.json mirrors it, and this
// module refuses to load if the two ever drift.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const OTEL_EVAL_ATTRS = Object.freeze({
  evaluationName: "gen_ai.evaluation.name",
  scoreValue: "gen_ai.evaluation.score.value",
  scoreLabel: "gen_ai.evaluation.score.label",
  explanation: "gen_ai.evaluation.explanation",
});

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "otel-eval-attributes.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")).attributes;

for (const [name, key] of Object.entries(OTEL_EVAL_ATTRS)) {
  if (fixture[name] !== key) {
    throw new Error(
      `otel.mjs constant '${name}'='${key}' does not match schema/otel-eval-attributes.json ('${fixture[name]}') — ` +
        "both must mirror lambda/eval-packager/index.mjs"
    );
  }
}
for (const name of Object.keys(fixture)) {
  if (!(name in OTEL_EVAL_ATTRS)) {
    throw new Error(
      `schema/otel-eval-attributes.json declares '${name}' which otel.mjs does not export`
    );
  }
}
