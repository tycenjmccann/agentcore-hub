/**
 * The model probe (TEAM-4995, DL-033) and the bearer-token minter it depends on.
 *
 * Same hermetic shape as the reconcile tests: an in-memory S3 with real ETag
 * semantics and canned answers for Converse / the Responses API / the coding
 * runtime, so "what does the probe send" and "when does it call a model green"
 * are both assertable without touching AWS.
 */
import { describe, it, expect } from 'vitest';
import {
  probeModel, runProbe, commandCountOf, slugify,
  MODELS_KEY, PROBE_PROMPT, CLI_TURN_TIMEOUT_MS,
} from './models-probe.mjs';
import {
  mintBedrockBearerToken, decodeBearerToken, queryString,
  TOKEN_PREFIX, TOKEN_VERSION, TOKEN_DURATION_SECONDS,
} from './bedrock-token.mjs';

const CLAUDE = {
  modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', family: 'claude-opus',
  endpoint: 'bedrock-runtime', region: 'us-east-1', api: 'converse', status: 'active',
};
const CODEX_MANTLE = {
  modelId: 'openai.gpt-5.5', vendor: 'openai', family: 'gpt',
  endpoint: 'bedrock-mantle', region: 'us-east-2', api: 'responses', status: 'active',
};
const CODEX_RUNTIME = {
  modelId: 'us.openai.gpt-6-sol', vendor: 'openai', family: 'gpt',
  endpoint: 'bedrock-runtime', region: 'us-east-1', api: 'responses', status: 'candidate',
};

const baseDoc = () => ({ version: 9, models: [CLAUDE, CODEX_MANTLE, CODEX_RUNTIME].map((r) => ({ ...r })) });

function harness(opts = {}) {
  const store = new Map();
  if (opts.doc !== null) store.set(MODELS_KEY, { body: JSON.stringify(opts.doc || baseDoc()), etag: '"e1"' });
  const calls = { converse: [], httpPost: [], turns: [], commands: [], stops: [], mint: [] };
  const puts = [];
  const logs = [];
  // Two ticks, 3.4s apart, so `seconds` is a fixed number in the assertions.
  const clock = [Date.parse('2026-09-24T04:00:00.000Z'), Date.parse('2026-09-24T04:00:03.400Z')];
  let tick = 0;

  const deps = {
    env: { CODING_AGENT_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/coding', ...(opts.env || {}) },
    log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => new Date(clock[Math.min(tick++, clock.length - 1)]),
    uuid: () => 'abc-123',
    async s3Get(key) {
      const hit = store.get(key);
      return hit ? { ...hit } : null;
    },
    async s3Put(key, body, o = {}) {
      puts.push({ key, body, ifMatch: o.ifMatch });
      if (o.ifMatch && store.get(key)?.etag !== o.ifMatch) {
        const e = new Error('precondition');
        e.name = 'PreconditionFailed';
        throw e;
      }
      store.set(key, { body, etag: '"e2"' });
    },
    async converse(args) {
      calls.converse.push(args);
      if (opts.converseThrow) throw new Error('AccessDeniedException');
      return opts.converse ?? { $metadata: { httpStatusCode: 200 }, output: { message: { content: [{ text: 'ok' }] } } };
    },
    async mintToken(region) {
      calls.mint.push(region);
      return 'bedrock-api-key-TOKEN';
    },
    async httpPost(args) {
      calls.httpPost.push(args);
      return opts.httpPost ?? { status: 200, body: { output: [{ type: 'message' }] }, text: '{}' };
    },
    async invokeCodingTurn(args) {
      calls.turns.push(args);
      if (opts.turnThrow) throw new Error('runtime 500');
      return opts.turn ?? { commandsExecuted: 3 };
    },
    async runCommand(args) {
      calls.commands.push(args);
      return opts.command ?? { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
    async stopSession(args) {
      calls.stops.push(args);
      if (opts.stopThrow) throw new Error('already stopped');
    },
  };

  return { deps, calls, puts, logs, store, written: () => JSON.parse(store.get(MODELS_KEY).body) };
}

const probeOf = (h, modelId) => JSON.parse(h.store.get(MODELS_KEY).body)
  .models.find((m) => m.modelId === modelId).probe;

// ─── api probe ──────────────────────────────────────────────────────────────

describe('probeModel — api', () => {
  it('calls Converse once for an anthropic row and records the result on the row', async () => {
    const h = harness();
    const res = await probeModel({ mode: 'probe', modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({
      statusCode: 200, ok: true, modelId: CLAUDE.modelId, mode: 'api', write: 'written', seconds: 3.4,
    });
    expect(h.calls.converse).toEqual([{
      region: 'us-east-1', modelId: CLAUDE.modelId, maxTokens: 16, text: 'Reply with the word ok.',
    }]);
    expect(probeOf(h, CLAUDE.modelId)).toEqual({ api: { ok: true, at: '2026-09-24T04:00:00.000Z', seconds: 3.4 } });
    // A probe result is evidence about a row, not an edit to the catalog: the
    // version must not move, or the reconcile's optimistic write loses a race
    // with every probe.
    expect(h.written().version).toBe(9);
    expect(h.puts[0].ifMatch).toBe('"e1"');
    expect(h.logs.join('\n')).toContain(`[models] probe.result modelId=${CLAUDE.modelId} mode=api ok=true`);
  });

  it('fails an anthropic row that answers with no text', async () => {
    const h = harness({ converse: { $metadata: { httpStatusCode: 200 }, output: { message: { content: [] } } } });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({ ok: false, error: 'empty response', write: 'written' });
    expect(probeOf(h, CLAUDE.modelId).api.error).toBe('empty response');
  });

  it('turns a thrown SDK error into a recorded failure, not an exception', async () => {
    const h = harness({ converseThrow: true });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({ ok: false, error: 'AccessDeniedException' });
  });

  it('posts to the Mantle Responses API with a bearer token and the Mantle-only project header', async () => {
    const h = harness();
    const res = await probeModel({ modelId: CODEX_MANTLE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({ ok: true, mode: 'api' });
    expect(h.calls.mint).toEqual(['us-east-2']);
    expect(h.calls.httpPost).toHaveLength(1);
    const post = h.calls.httpPost[0];
    expect(post.url).toBe('https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses');
    expect(post.headers.authorization).toBe('Bearer bedrock-api-key-TOKEN');
    expect(post.headers['OpenAI-Project']).toBe('default');
    expect(post.body).toEqual({ model: CODEX_MANTLE.modelId, input: 'Reply with ok', max_output_tokens: 16 });
  });

  it('omits the project header on Bedrock Runtime, which rejects the request that carries it', async () => {
    const h = harness();
    await probeModel({ modelId: CODEX_RUNTIME.modelId, probe: 'api' }, h.deps);
    const post = h.calls.httpPost[0];
    expect(post.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses');
    expect(post.headers['OpenAI-Project']).toBeUndefined();
  });

  it('fails an OpenAI-shaped row on a non-200 and on an empty output array', async () => {
    const bad = harness({ httpPost: { status: 403, body: null, text: 'not authorized for this model' } });
    expect(await probeModel({ modelId: CODEX_MANTLE.modelId, probe: 'api' }, bad.deps))
      .toMatchObject({ ok: false, error: 'http 403 not authorized for this model' });

    const empty = harness({ httpPost: { status: 200, body: { output: [] }, text: '{}' } });
    expect(await probeModel({ modelId: CODEX_MANTLE.modelId, probe: 'api' }, empty.deps))
      .toMatchObject({ ok: false, error: 'no output items' });
  });
});

// ─── cli probe ──────────────────────────────────────────────────────────────

describe('probeModel — cli', () => {
  it('drives one real coding turn, reads the file back, and always stops the session', async () => {
    const h = harness();
    const res = await probeModel({ modelId: CODEX_MANTLE.modelId, probeMode: 'cli' }, h.deps);
    expect(res).toMatchObject({ ok: true, mode: 'cli', write: 'written' });

    expect(h.calls.turns).toHaveLength(1);
    const turn = h.calls.turns[0];
    const sessionId = turn.sessionId;
    // The session id carries a uuid so two probes of the same model in the same
    // second cannot collide on one container.
    expect(sessionId).toBe(`probe-openai-gpt-5-5-${Math.floor(Date.parse('2026-09-24T04:00:03.400Z') / 1000)}-abc-123`);
    expect(turn.payload).toEqual({
      prompt: PROBE_PROMPT,
      cli: 'codex',
      model: CODEX_MANTLE.modelId,
      session_id: sessionId,
      origin: 'probe',
    });
    expect(h.calls.commands[0]).toMatchObject({ sessionId, command: 'cat hello.txt', timeoutMs: 30_000 });
    expect(h.calls.stops).toEqual([{ runtimeArn: h.deps.env.CODING_AGENT_RUNTIME_ARN, sessionId }]);
    expect(CLI_TURN_TIMEOUT_MS).toBe(300_000);
  });

  it('sends cli=claude for an anthropic row', async () => {
    const h = harness();
    await probeModel({ modelId: CLAUDE.modelId, probe: 'cli' }, h.deps);
    expect(h.calls.turns[0].payload.cli).toBe('claude');
  });

  it('fails when the file does not say ok, and still releases the session', async () => {
    const h = harness({ command: { stdout: 'Sure! I can help with that.\n', exitCode: 0 } });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'cli' }, h.deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('hello.txt is "Sure! I can help with that."');
    expect(h.calls.stops).toHaveLength(1);
  });

  it('fails a turn that answered in prose without executing a command', async () => {
    const h = harness({ turn: { commandsExecuted: 0 } });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'cli' }, h.deps);
    expect(res).toMatchObject({ ok: false, error: 'turn reported no command execution' });
  });

  it('fails without calling the runtime when no coding runtime is configured', async () => {
    const h = harness({ env: { CODING_AGENT_RUNTIME_ARN: '' } });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'cli' }, h.deps);
    expect(res).toMatchObject({ ok: false, error: 'CODING_AGENT_RUNTIME_ARN unset' });
    expect(h.calls.turns).toEqual([]);
    expect(h.calls.stops).toEqual([]);
  });

  it('reports the turn failure and does not mask it with the session-stop failure', async () => {
    const h = harness({ turnThrow: true, stopThrow: true });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'cli' }, h.deps);
    expect(res).toMatchObject({ ok: false, error: 'runtime 500' });
    expect(h.logs.join('\n')).toContain('probe.session-stop-failed');
  });
});

// ─── event validation and persistence ───────────────────────────────────────

describe('probeModel — event handling', () => {
  it('rejects a model id that is not a model id, before reading anything', async () => {
    const h = harness();
    for (const modelId of ['', '; rm -rf /', '../../etc/passwd', 'a'.repeat(200), 'x y']) {
      const res = await probeModel({ modelId, probe: 'api' }, h.deps);
      expect(res.statusCode).toBe(400);
      expect(res.ok).toBe(false);
    }
    expect(h.calls.converse).toEqual([]);
    expect(h.puts).toEqual([]);
    expect(h.logs.join('\n')).toContain('probe.rejected');
  });

  it('rejects an unknown probe mode', async () => {
    const h = harness();
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'smoke' }, h.deps);
    expect(res).toMatchObject({ statusCode: 400, ok: false, error: 'probe must be one of api, cli' });
  });

  it('404s a model that is not in the catalog', async () => {
    const h = harness();
    const res = await probeModel({ modelId: 'us.anthropic.claude-opus-9', probe: 'api' }, h.deps);
    expect(res).toMatchObject({ statusCode: 404, ok: false, error: 'no such model in the catalog' });
    expect(h.calls.converse).toEqual([]);
  });

  it('503s when the registry cannot be read', async () => {
    const h = harness({ doc: null });
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({ statusCode: 503, ok: false, error: 'registry unreadable' });
  });

  it('defaults to the api probe when the event names none', async () => {
    const h = harness();
    const res = await probeModel({ modelId: CLAUDE.modelId }, h.deps);
    expect(res).toMatchObject({ mode: 'api', ok: true });
  });

  it('reports conflict instead of clobbering a document that moved under it', async () => {
    const h = harness();
    const original = h.deps.s3Get;
    h.deps.s3Get = async (key) => {
      const got = await original(key);
      return got ? { ...got, etag: '"someone-else"' } : got;
    };
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    expect(res).toMatchObject({ ok: true, write: 'conflict' });
    expect(h.logs.join('\n')).toContain(`probe.write-failed modelId=${CLAUDE.modelId}`);
  });

  it('honours persist:false by running the probe and writing nothing', async () => {
    const h = harness();
    const res = await probeModel({ modelId: CLAUDE.modelId, probe: 'api', persist: false }, h.deps);
    expect(res).toMatchObject({ ok: true, write: 'skipped' });
    expect(h.calls.converse).toHaveLength(1);
    expect(h.puts).toEqual([]);
  });

  it('preserves an existing probe result for the other mode', async () => {
    const doc = baseDoc();
    doc.models[0].probe = { cli: { ok: false, at: '2026-09-01T00:00:00Z', error: 'old' } };
    const h = harness({ doc });
    await probeModel({ modelId: CLAUDE.modelId, probe: 'api' }, h.deps);
    const probe = probeOf(h, CLAUDE.modelId);
    expect(probe.cli).toEqual({ ok: false, at: '2026-09-01T00:00:00Z', error: 'old' });
    expect(probe.api.ok).toBe(true);
  });
});

describe('runProbe', () => {
  it('never writes the registry — that is the contract the reconcile relies on', async () => {
    const h = harness();
    const result = await runProbe(CLAUDE, 'api', h.deps);
    expect(result).toEqual({ ok: true, at: '2026-09-24T04:00:00.000Z', seconds: 3.4 });
    expect(h.puts).toEqual([]);
  });
});

describe('helpers', () => {
  it('slugify makes a model id safe for a session id', () => {
    expect(slugify('us.anthropic.claude-opus-5')).toBe('us-anthropic-claude-opus-5');
    expect(slugify('anthropic.claude:v1.0')).toBe('anthropic-claude-v1-0');
    expect(slugify(`${'x'.repeat(60)}`)).toHaveLength(48);
  });

  it('commandCountOf reads every shape the runtime has returned', () => {
    expect(commandCountOf({ commandsExecuted: 3 })).toBe(3);
    expect(commandCountOf({ toolUses: [{}, {}] })).toBe(2);
    expect(commandCountOf({ result: { commandCount: 1 } })).toBe(1);
    expect(commandCountOf({ text: 'done' })).toBe(0);
    expect(commandCountOf(null)).toBe(0);
  });
});

// ─── bearer token ───────────────────────────────────────────────────────────

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' };

describe('mintBedrockBearerToken', () => {
  it('produces the prefixed, base64 form the OpenAI-shaped endpoints accept', async () => {
    const token = await mintBedrockBearerToken('us-east-2', CREDS);
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const url = decodeBearerToken(token);
    // No scheme: the reference implementation strips `https://` before encoding,
    // and a token that keeps it is rejected.
    expect(url.startsWith('https://')).toBe(false);
    expect(url.startsWith('bedrock.amazonaws.com/?')).toBe(true);
    expect(url.endsWith(TOKEN_VERSION)).toBe(true);
  });

  it('signs for the target region with a 12-hour presign', async () => {
    const url = decodeBearerToken(await mintBedrockBearerToken('us-west-2', CREDS));
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain(`X-Amz-Expires=${TOKEN_DURATION_SECONDS}`);
    expect(TOKEN_DURATION_SECONDS).toBe(43200);
    expect(url).toContain('%2Fus-west-2%2Fbedrock%2Faws4_request');
    expect(url).toContain('X-Amz-Security-Token=session-token');
    expect(url).toContain('Action=CallWithBearerToken');
  });

  it('is deterministic for a given signing minute, and differs by region', async () => {
    const [a, b, c] = await Promise.all([
      mintBedrockBearerToken('us-east-1', CREDS),
      mintBedrockBearerToken('us-east-1', CREDS),
      mintBedrockBearerToken('us-east-2', CREDS),
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('returns null for anything that is not one of our tokens', () => {
    expect(decodeBearerToken('sk-live-whatever')).toBeNull();
    expect(decodeBearerToken(undefined)).toBeNull();
  });

  it('percent-encodes the query the way botocore does', () => {
    expect(queryString({ b: 'x/y+z=', a: "it's" })).toBe('a=it%27s&b=x%2Fy%2Bz%3D');
  });
});
