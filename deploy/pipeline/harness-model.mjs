/**
 * harness-model.mjs — which model a harness setup script re-pins its harness to,
 * read from the ONE model registry (config/models.json, DL-033).
 *
 * The three harness setup scripts (setup-builder-agent.mjs,
 * workflow-manager/setup-workflow-manager.mjs,
 * routine-builder/setup-routine-builder.mjs) carried three near-identical inline
 * copies of this, justified by "a new shared module would have to be on the CD
 * Deploy role's path in all three deploy surfaces". That was never true: all
 * three already import ./harness-snapshot.mjs from this very directory. Three
 * copies meant the same bug three times — TEAM-5034, where every one of them
 * reported ERR_MODULE_NOT_FOUND on `import("@aws-sdk/client-s3")` as
 * `reason=s3 (Error)` because Target 2b's scratch node_modules did not carry the
 * S3 client, and all three silently re-pinned their LITERAL_MODEL_ID over
 * whatever an operator had pinned on /models.
 *
 * So: one module, no AWS import at the top level, every seam injected — the S3
 * client, the registry loader, the logger and process.exit — which is what makes
 * it unit-testable (harness-model.test.mjs) with no AWS and no network.
 *
 * Two log lines are a contract, not decoration:
 *   [models] registry.fallback reason=<s3|module-missing|import|parse> name=… code=… message=…
 *   [models] harness.model agentId=… modelId=… source=…
 * `source` is CHAIN_STEPS from src/lib/models/models-registry.mjs — the closed
 * vocabulary every loader answers in. `reason` distinguishes the four ways the
 * read can fail, because "the SDK is missing from this container" and "S3 said
 * no" need different fixes and the old single reason hid that.
 *
 * NOTE: deliberately NO model id literal in this file. Each script's
 * LITERAL_MODEL_ID is its own documented last resort (and its own allow entry in
 * scripts/check-model-surface.sh); it arrives here as a parameter.
 */

/** The registry document's key in the artifact bucket. */
export const REGISTRY_KEY = "config/models.json";

/** Chain steps that mean the model came OUT OF the registry document. Anything
 *  else — `env` ($MODEL_ID) or `literal` — is a model the document did not
 *  choose, which under PIPELINE_MODE is a failure (see resolveHarnessModel). */
const DOCUMENT_SOURCES = ["override", "agents", "defaults"];

/**
 * An error as one log-safe line: `name=… code=… message=…`.
 *
 * Only those three fields, never the error object and never a stack: the whole
 * point is a line an operator can read in a CodeBuild log. `message` is
 * collapsed to a single line and capped, so a multi-KB SDK message cannot bury
 * the rest of the deploy log.
 */
export function formatErr(err) {
  const name = err?.name || "Error";
  const code = err?.code ?? err?.Code ?? err?.$metadata?.httpStatusCode ?? "-";
  const message = String(err?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `name=${name} code=${code} message=${message}`;
}

/** `{reason, name, code, message}` — the failure as data, for the caller's gate. */
function failure(reason, err) {
  return {
    reason,
    name: err?.name || "Error",
    code: err?.code ?? err?.Code ?? err?.$metadata?.httpStatusCode ?? "-",
    message: String(err?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/** ERR_MODULE_NOT_FOUND is "this container does not ship the package", which is a
 *  different fix from any other import error — TEAM-5034 was exactly that. */
function importReason(err) {
  return err?.code === "ERR_MODULE_NOT_FOUND" ? "module-missing" : "import";
}

/**
 * Read the LIVE registry document from S3 → `{doc, error}`.
 *
 * `doc` is the parsed JSON (NOT validated — that is resolveHarnessModel's job,
 * and the builder also wants the raw catalog for its prompt copy). `error` is
 * null, or the failure as data with a `reason` naming which step failed:
 *   module-missing / import  the S3 client itself could not be imported
 *   s3                       GetObject (or the body read) threw
 *   parse                    the object is not JSON
 * Logs exactly one `registry.fallback` line on failure, so the caller never has
 * to log the same failure twice.
 */
export async function loadRegistryDoc({
  bucket,
  region,
  key = REGISTRY_KEY,
  importS3 = () => import("@aws-sdk/client-s3"),
  log = console,
} = {}) {
  const fallback = (reason, err) => {
    const error = failure(reason, err);
    log.log(`[models] registry.fallback reason=${reason} ${formatErr(err)}`);
    return { doc: null, error };
  };

  let S3Client;
  let GetObjectCommand;
  try {
    ({ S3Client, GetObjectCommand } = await importS3());
  } catch (err) {
    return fallback(importReason(err), err);
  }

  let body;
  try {
    // An explicit region: a deploy container that never set AWS_REGION would
    // otherwise fail region resolution inside the client, which reads as an S3
    // outage in the log.
    const res = await new S3Client({ region }).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    body = await res.Body.transformToString();
  } catch (err) {
    return fallback("s3", err);
  }

  try {
    return { doc: JSON.parse(body), error: null };
  } catch (err) {
    return fallback("parse", err);
  }
}

/**
 * The model to re-pin `agentId`'s harness to → the chosen model id.
 *
 * The registry answers (agents pin -> defaults.persona -> $MODEL_ID); a `literal`
 * chain result keeps THIS script's documented `literalModelId` rather than the
 * registry's generic persona floor.
 *
 * Under `pipelineMode` this FAILS CLOSED. A registry that could not be read,
 * imported or parsed — and equally a readable document that did not itself
 * choose the model (`source` of `literal` or `env`) — means the deploy is about
 * to re-pin the harness from a literal in this repo, silently reverting whatever
 * an operator pinned on /models. That is the defect TEAM-5034 found in
 * production, so the script exits non-zero here, BEFORE any UpdateHarness,
 * rather than shipping a model nobody chose. A hand-run (no PIPELINE_MODE) keeps
 * today's behaviour — the literal — but says so out loud.
 *
 * A readable document with no `agents.<agentId>` pin is NOT a failure: the agent
 * follows `defaults.persona` by design. It gets a WARN naming the consequence,
 * because "nobody has pinned this harness yet" is invisible otherwise.
 */
export async function resolveHarnessModel({
  agentId,
  doc,
  docError = null,
  literalModelId,
  pipelineMode = false,
  env = process.env,
  log = console,
  exit = (c) => process.exit(c),
  importRegistry = () =>
    import(new URL("../../src/lib/models/models-registry.mjs", import.meta.url).href),
} = {}) {
  let resolveAgentModel;
  let validateRegistry;
  try {
    // The canonical resolver (byte-copied to the token-aggregator and Telegram
    // bridge Lambdas, scripts/check-models-registry-parity.sh).
    ({ resolveAgentModel, validateRegistry } = await importRegistry());
  } catch (err) {
    const reason = importReason(err);
    log.log(`[models] registry.fallback reason=${reason} ${formatErr(err)}`);
    return refuse({ agentId, literalModelId, pipelineMode, log, exit, chosen: literalModelId });
  }

  let reg = null;
  let error = docError;
  if (!error) {
    try {
      if (!doc) throw new Error("no registry document");
      reg = validateRegistry ? validateRegistry(doc).registry : doc;
      if (!reg) throw new Error("invalid registry document");
    } catch (err) {
      error = failure("parse", err);
      log.log(`[models] registry.fallback reason=parse ${formatErr(err)}`);
    }
  }

  const { modelId, source } = resolveAgentModel(reg, agentId, "", env);
  // `literal` means nothing in the catalog or the env named a model. Keep THIS
  // harness's documented default rather than the registry's generic persona
  // literal.
  const chosen = source === "literal" ? literalModelId : modelId;
  log.log(`[models] harness.model agentId=${agentId} modelId=${chosen} source=${source}`);

  if (error || !DOCUMENT_SOURCES.includes(source)) {
    return refuse({ agentId, literalModelId, pipelineMode, log, exit, chosen, source });
  }

  if (source === "defaults") {
    log.log(
      `[models] WARN ${agentId} has no agents.${agentId} pin in ${REGISTRY_KEY} — ` +
        `following defaults.persona (${chosen}); pin it on /models to choose a different model`,
    );
  }
  return chosen;
}

/** The fail-closed half of resolveHarnessModel: FATAL + exit under PIPELINE_MODE,
 *  WARN + carry on outside it. */
function refuse({ agentId, literalModelId, pipelineMode, log, exit, chosen, source }) {
  if (pipelineMode) {
    log.log(
      `[models] FATAL harness model NOT taken from registry for ${agentId} — ` +
        `refusing to re-pin from the literal ${literalModelId} under PIPELINE_MODE ` +
        `(an operator repin on /models would be silently reverted)`,
    );
    return exit(1);
  }
  // $MODEL_ID is the one non-document source that is not the literal; name it,
  // so the line never claims to be keeping a literal it is not keeping.
  const kept = source === "env" ? `$MODEL_ID ${chosen}` : `literal ${chosen}`;
  log.log(`[models] WARN harness model NOT taken from registry — keeping ${kept}`);
  return chosen;
}
