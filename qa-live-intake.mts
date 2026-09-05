// QA untracked harness (TEAM-4064): drive the REAL validateIntakeSources with
// real network + real AWS SDK, no mocks. Run: npx tsx qa-live-intake.mts
import { readFileSync } from "node:fs";
import { validateIntakeSources, shouldRejectSubmission, getSourceValidationMode } from "./src/lib/workflow/intake";
import type { IntakeSource } from "./src/lib/workflow/types";

const presigned = readFileSync("/tmp/qa/presigned.txt", "utf8").trim();

const sources: IntakeSource[] = [
  { type: "s3", value: "s3://agentcore-hub-artifacts-838829463875-us-east-1/workflows/wf_1788582225496_yteqfl/shared/qa-evidence/probe.txt" },
  { type: "url", value: presigned },
  { type: "s3", value: "s3://agentcore-hub-artifacts-023392223961-us-east-1/workflow-sources/juno-ehr-2026-09-04/README.md" },
  { type: "s3", value: "s3://agentcore-hub-artifacts-838829463875-us-east-1/workflows/wf_1788582225496_yteqfl/shared/qa-evidence/does-not-exist.txt" },
  { type: "s3", value: "s3://no-slash-key" },
  // Extra QA source (NOT in the ticket's list): a genuine public URL to prove the
  // GET-Range verified path works over real network, since this role cannot read S3.
  { type: "url", value: "https://raw.githubusercontent.com/tycenjmccann/agentcore-hub/main/README.md" },
];

function redact(s: string): string {
  return s
    .replace(/(Signature=)[^&"]+/gi, "$1REDACTED")
    .replace(/(X-Amz-Signature=)[^&"]+/gi, "$1REDACTED")
    .replace(/(x-amz-security-token=)[^&"]+/gi, "$1REDACTED")
    .replace(/(AWSAccessKeyId=)[^&"]+/gi, "$1REDACTED")
    .replace(/(X-Amz-Credential=)[^&"]+/gi, "$1REDACTED");
}

async function run(label: string, env: NodeJS.ProcessEnv) {
  const mode = getSourceValidationMode(env);
  const result = await validateIntakeSources(sources, { env });
  const lenient = shouldRejectSubmission(result, "lenient");
  const strict = shouldRejectSubmission(result, "strict");
  console.log(`\n================ ${label} (getSourceValidationMode -> ${mode}) ================`);
  console.log(JSON.stringify(
    {
      results: result.results.map((r) => ({ value: redact(r.source.value), outcome: r.outcome, method: r.method, detail: redact(r.detail ?? "") })),
      stampedSources: result.sources.map((s) => ({ value: redact(s.value), verification: { ...s.verification, detail: redact(s.verification?.detail ?? "") } })),
      definitiveErrors: result.definitiveErrors.map(redact),
      transientErrors: result.transientErrors.map(redact),
      shouldRejectSubmission_lenient: { reject: lenient.reject, errors: lenient.errors.map(redact) },
      shouldRejectSubmission_strict: { reject: strict.reject, errors: strict.errors.map(redact) },
    },
    null, 2,
  ));
  return result;
}

(async () => {
  // Extract the actual signature/token values from the presigned URL to grep for leaks.
  const sigMatch = presigned.match(/(?:X-Amz-Signature|Signature)=([^&]+)/i);
  const tokMatch = presigned.match(/x-amz-security-token=([^&]+)/i);
  const sigVal = sigMatch ? decodeURIComponent(sigMatch[1]) : "";
  const tokVal = tokMatch ? decodeURIComponent(tokMatch[1]) : "";

  delete process.env.SOURCE_VALIDATION_MODE;
  const lenientResult = await run("LENIENT (SOURCE_VALIDATION_MODE unset)", { ...process.env });
  const strictResult = await run("STRICT (SOURCE_VALIDATION_MODE=strict)", { ...process.env, SOURCE_VALIDATION_MODE: "strict" });

  // Leak check: does the RAW (unredacted) surfaced output contain the real signature?
  const rawSurface = JSON.stringify([lenientResult, strictResult].map((r) => ({
    details: r.results.map((x) => x.detail),
    markers: r.sources.map((s) => s.verification?.detail),
    definitiveErrors: r.definitiveErrors,
    transientErrors: r.transientErrors,
  })));
  const leakSig = sigVal && rawSurface.includes(sigVal);
  const leakTok = tokVal && rawSurface.includes(tokVal);
  console.log("\n================ SIGNATURE LEAK CHECK ================");
  console.log("presigned signature value present in validator output (surfaced details/markers/errors)?", !!leakSig);
  console.log("presigned security-token value present in validator output?", !!leakTok);
  console.log("(grep of the raw un-redacted validator surface for the literal signature -> matches:", leakSig ? "FOUND (LEAK)" : "0", ")");
})();
