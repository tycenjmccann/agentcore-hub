/**
 * Model probe (TEAM-4995, DL-033) — `{"mode":"probe"}` on this Lambda.
 *
 * "The registry lists it" and "it actually answers" are different claims. A row
 * can name a model the account has no access to, an endpoint that 404s, or a
 * Codex model the CLI refuses to drive — and the only way to know is to make the
 * call. `autoAdopt` in the reconcile REQUIRES a green probe before it moves a
 * tier, so this module is the gate between discovery and production traffic.
 *
 * Two kinds of probe, because there are two kinds of failure:
 *   - `api`  — one minimal inference call on the row's own endpoint. Proves
 *              access, region and wire format.
 *   - `cli`  — one real coding turn on the coding runtime: write a file, read it
 *              back. Proves the thing the fleet actually does with a coding
 *              model, which an API call cannot (a model can answer Converse and
 *              still be unable to drive a tool loop).
 *
 * Every AWS call is injected through `deps`, so the tests are hermetic and the
 * production wiring lives in one place (`index.mjs` `buildDeps()`).
 *
 * PERSISTENCE IS OPT-OUT, and the reason matters: the reconcile calls
 * `runProbe()` DIRECTLY (via its `probeCli` dep) precisely so the probe does not
 * write `config/models.json` behind its back — the reconcile is mid-transaction
 * on that document and carries the probe result into its own single write. A
 * probe that bumped the version there would make the reconcile's own optimistic
 * check fail every time it auto-adopted anything.
 */

import { MODEL_ID_RE, baseUrlFor } from './models-registry.mjs';

export const MODELS_KEY = 'config/models.json';
export const PROBE_PROMPT = 'create hello.txt containing ok, then cat it';
export const PROBE_FILE = 'hello.txt';
export const PROBE_EXPECT = 'ok';
export const API_TIMEOUT_MS = 30_000;
export const CLI_TURN_TIMEOUT_MS = 300_000;
export const CLI_COMMAND_TIMEOUT_MS = 30_000;

export const PROBE_MODES = ['api', 'cli'];

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** True only when `storedAt` is a real, later timestamp than `at`. Missing or
 *  unparsable input on either side is treated as "not later" (returns false),
 *  so an outcome with no comparable timestamp is never blocked from writing.
 *  Mirrors `newerThan()` in `src/app/api/models/probe/record.ts` — copied
 *  rather than imported, since this is a `.mjs` Lambda and that is a TS route. */
function newerThan(storedAt, at) {
  const stored = storedAt ? Date.parse(storedAt) : NaN;
  const candidate = Date.parse(at);
  if (Number.isNaN(stored) || Number.isNaN(candidate)) return false;
  return stored > candidate;
}

/** Record `outcome` at `row.probe[mode]` unless the row already holds a NEWER
 *  one (`newerThan`, strict). Returns true when written, false when superseded.
 *  The one rule every writer of a probe outcome uses — `persistProbe` here, and
 *  the reconcile's autoAdopt and pre-write merge (TEAM-5144) — so the ordering
 *  cannot drift between them. */
export function applyProbeOutcome(row, mode, outcome) {
  const current = isPlainObject(row.probe) ? row.probe[mode] : undefined;
  if (newerThan(current?.at, outcome?.at)) return false;
  row.probe = { ...(isPlainObject(row.probe) ? row.probe : {}), [mode]: outcome };
  return true;
}

/** A session-id-safe form of a model id: the id's own charset includes `.` and
 *  `:`, which the session id may not carry. */
export const slugify = (id) => String(id ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** A dep that hangs must not hold the whole Lambda. Every call is raced against
 *  its own budget; the loser's timer is always cleared so the event loop drains. */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const errText = (e) => String((e && (e.message || e.name)) || e || 'error').slice(0, 300);

/** Concatenated assistant text from a Converse response. */
function converseText(res) {
  const content = res?.output?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('').trim();
}

/** How many commands (tool calls) the coding turn reported. A coding model that
 *  answers in prose without touching the shell has not passed a CLI probe, even
 *  if a leftover hello.txt happens to say ok. */
export function commandCountOf(resp) {
  if (!isPlainObject(resp)) return 0;
  for (const key of ['commandsExecuted', 'commandCount', 'toolUses', 'tool_uses', 'commands']) {
    const v = resp[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.length;
  }
  const nested = resp.result ?? resp.turn ?? resp.summary;
  return isPlainObject(nested) ? commandCountOf(nested) : 0;
}

// ─── The two probes ──────────────────────────────────────────────────────────

async function probeApi(row, deps) {
  const region = row.region;
  const api = row.api || (row.vendor === 'openai' ? 'responses' : 'converse');
  if (api === 'converse') {
    const res = await withTimeout(
      deps.converse({ region, modelId: row.modelId, maxTokens: 16, text: 'Reply with the word ok.' }),
      API_TIMEOUT_MS, 'converse',
    );
    const status = res?.$metadata?.httpStatusCode ?? 200;
    const text = converseText(res);
    if (status !== 200) return { ok: false, error: `http ${status}` };
    if (!text) return { ok: false, error: 'empty response' };
    return { ok: true };
  }

  // OpenAI-shaped: Bedrock Runtime's /openai/v1 and Mantle's speak the same
  // Responses API and authenticate with a bearer token minted from this
  // Lambda's role. `OpenAI-Project` is a Mantle-only header — Bedrock Runtime
  // rejects the request that carries it.
  const token = await withTimeout(deps.mintToken(region), API_TIMEOUT_MS, 'mint bearer token');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (row.endpoint === 'bedrock-mantle') headers['OpenAI-Project'] = 'default';
  const res = await withTimeout(deps.httpPost({
    url: `${baseUrlFor(row.endpoint, region)}/responses`,
    headers,
    body: { model: row.modelId, input: 'Reply with ok', max_output_tokens: 16 },
    timeoutMs: API_TIMEOUT_MS,
  }), API_TIMEOUT_MS, 'responses');
  if (res?.status !== 200) {
    return { ok: false, error: `http ${res?.status ?? '?'} ${trimmed(res?.text).slice(0, 120)}`.trim() };
  }
  const output = res?.body?.output;
  if (!Array.isArray(output) || output.length === 0) return { ok: false, error: 'no output items' };
  return { ok: true };
}

async function probeCliTurn(row, deps) {
  const arn = trimmed(deps.env?.CODING_AGENT_RUNTIME_ARN);
  if (!arn) return { ok: false, error: 'CODING_AGENT_RUNTIME_ARN unset' };
  // `origin: "probe"` is load-bearing: the coding runtime's session GC only
  // touches the workflow marker for workflow AND probe origins, so a probe
  // session is not reaped mid-turn (deploy/coding-agent-runtime/main.py).
  const sessionId = `probe-${slugify(row.modelId)}-${Math.floor(deps.now().getTime() / 1000)}-${deps.uuid()}`;
  let turn = null;
  try {
    turn = await withTimeout(deps.invokeCodingTurn({
      runtimeArn: arn,
      sessionId,
      payload: {
        prompt: PROBE_PROMPT,
        cli: row.vendor === 'openai' ? 'codex' : 'claude',
        model: row.modelId,
        session_id: sessionId,
        origin: 'probe',
      },
    }), CLI_TURN_TIMEOUT_MS, 'coding turn');

    const cmd = await withTimeout(deps.runCommand({
      runtimeArn: arn,
      sessionId,
      command: `cat ${PROBE_FILE}`,
      timeoutMs: CLI_COMMAND_TIMEOUT_MS,
    }), CLI_COMMAND_TIMEOUT_MS, 'cat probe file');

    const content = trimmed(cmd?.stdout);
    if (content !== PROBE_EXPECT) {
      return { ok: false, error: `${PROBE_FILE} is ${JSON.stringify(content.slice(0, 60))}, want "${PROBE_EXPECT}"` };
    }
    const commands = commandCountOf(turn);
    if (commands < 1) return { ok: false, error: 'turn reported no command execution' };
    return { ok: true };
  } finally {
    // Always release the compute, including on the failure paths above: a probe
    // that leaks a session leaks an EBS volume or an EFS directory.
    try {
      await withTimeout(deps.stopSession({ runtimeArn: arn, sessionId }), CLI_COMMAND_TIMEOUT_MS, 'stop session');
    } catch (e) {
      deps.log.warn?.(`[models] probe.session-stop-failed sessionId=${sessionId} error=${errText(e)}`);
    }
  }
}

/**
 * Run one probe against one catalog row. Pure w.r.t. the registry document —
 * nothing is written here (see the module comment).
 *
 * `at` is stamped from the FINISH time, not the start: it is compared against
 * a stored outcome's `at` by `persistProbe`'s `newerThan()` guard, and a probe
 * that started earlier but finished later than another must still be able to
 * win that comparison (TEAM-5132).
 *
 * @returns {Promise<{ok:boolean, at:string, seconds:number, error?:string}>}
 */
export async function runProbe(row, mode, deps) {
  const started = deps.now().getTime();
  let result;
  try {
    result = mode === 'cli' ? await probeCliTurn(row, deps) : await probeApi(row, deps);
  } catch (e) {
    result = { ok: false, error: errText(e) };
  }
  const finished = deps.now().getTime();
  const out = {
    ok: Boolean(result.ok),
    at: new Date(finished).toISOString(),
    seconds: Math.round((finished - started) / 100) / 10,
  };
  if (!out.ok) out.error = result.error || 'failed';
  deps.log.log(`[models] probe.result modelId=${row.modelId} mode=${mode} ok=${out.ok} `
    + `seconds=${out.seconds} error=${out.error ?? ''}`);
  return out;
}

// ─── Handler entry ───────────────────────────────────────────────────────────

/** Read `config/models.json`, keeping the ETag for the conditional write back. */
async function readDoc(deps) {
  const got = await deps.s3Get(MODELS_KEY);
  if (!got) return null;
  try {
    return { doc: JSON.parse(got.body), etag: got.etag };
  } catch {
    return null;
  }
}

/** Write `probe.<mode>` onto the row. Read-before-write with `IfMatch`, so a
 *  probe can never clobber an operator edit or a concurrent reconcile — it
 *  reports `conflict` and the next run re-probes. The catalog CONTENT is
 *  untouched, so the version is left alone: a probe result is evidence about a
 *  row, not a change to what the row says.
 *
 *  Also never clobbers a NEWER outcome with an older one (TEAM-5132): if the
 *  row already holds a probe result whose `at` is later than the one being
 *  written, the write is skipped (`superseded`) instead of overwriting a
 *  more recent result with a stale one — the same guard as `newerThan()` /
 *  `writeOnce()` in `src/app/api/models/probe/record.ts`. This function has no
 *  retry loop today (one read, one CAS), so the check runs once against the
 *  fresh read above; if a retry loop is ever added here, the check must move
 *  inside it so each re-read is re-checked. */
async function persistProbe(deps, modelId, mode, result) {
  const fresh = await readDoc(deps);
  if (!fresh) return 'failed';
  // The RAW document keeps its rows under `catalog` and nowhere else
  // (TEAM-5022) — reading `models` here found nothing in the real registry, so
  // every probe answered 404 and no result was ever written.
  const rows = Array.isArray(fresh.doc?.catalog) ? fresh.doc.catalog : [];
  const row = rows.find((r) => r?.modelId === modelId);
  if (!row) return 'failed';
  const current = isPlainObject(row.probe) ? row.probe[mode] : undefined;
  if (!applyProbeOutcome(row, mode, result)) {
    deps.log.warn?.(`[models] probe.write_superseded modelId=${modelId} mode=${mode} `
      + `at=${result.at} current=${current?.at}`);
    return 'superseded';
  }
  try {
    await deps.s3Put(MODELS_KEY, JSON.stringify(fresh.doc, null, 2), { ifMatch: fresh.etag });
    return 'written';
  } catch (e) {
    deps.log.warn?.(`[models] probe.write-failed modelId=${modelId} error=${errText(e)}`);
    return 'conflict';
  }
}

/**
 * `{mode:"probe", modelId, probe:"api"|"cli"}` (`probeMode` accepted as an alias
 * for `probe`; `persist:false` runs the probe without writing the row).
 */
export async function probeModel(event, deps) {
  const modelId = trimmed(event?.modelId);
  const mode = (trimmed(event?.probe) || trimmed(event?.probeMode) || 'api').toLowerCase();

  if (!MODEL_ID_RE.test(modelId)) {
    deps.log.warn?.(`[models] probe.rejected modelId=${JSON.stringify(modelId)} reason=bad-model-id`);
    return { statusCode: 400, ok: false, modelId, mode, error: 'modelId does not match MODEL_ID_RE' };
  }
  if (!PROBE_MODES.includes(mode)) {
    return { statusCode: 400, ok: false, modelId, mode, error: `probe must be one of ${PROBE_MODES.join(', ')}` };
  }

  const current = await readDoc(deps);
  if (!current) {
    deps.log.warn?.('[models] probe.failed reason=registry_missing');
    return { statusCode: 503, ok: false, modelId, mode, error: 'registry unreadable' };
  }
  const rows = Array.isArray(current.doc?.catalog) ? current.doc.catalog : [];
  const row = rows.find((r) => r?.modelId === modelId);
  if (!row) {
    deps.log.warn?.(`[models] probe.failed modelId=${modelId} reason=unknown_model`);
    return { statusCode: 404, ok: false, modelId, mode, error: 'no such model in the catalog' };
  }

  const result = await runProbe(row, mode, deps);
  const write = event?.persist === false ? 'skipped' : await persistProbe(deps, modelId, mode, result);
  return { statusCode: 200, modelId, mode, write, ...result };
}
