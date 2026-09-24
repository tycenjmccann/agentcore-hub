/**
 * Production AWS wiring for the model registry's reconcile and probe modes
 * (TEAM-4995, DL-033).
 *
 * `models-reconcile.mjs` and `models-probe.mjs` take every AWS call as an
 * injected `deps` object, which is what makes them hermetically testable. This
 * file is the one place that knows how those calls are actually spelled, and the
 * one place a credential or a region is chosen.
 *
 * It exists as its own module for two reasons:
 *   - the heavy SDK clients are DYNAMICALLY imported below, so the aggregation
 *     hot path (a CloudWatch Logs subscription firing thousands of times a day)
 *     never pays to parse the Bedrock, Pricing and AgentCore clients on a cold
 *     start for two invocations a day that use them;
 *   - `index.mjs` can be tested for its ROUTING without the SDKs being installed
 *     at all, by mocking this module.
 *
 * The local `./*.mjs` imports stay static so
 * scripts/check-lambda-zip-manifest.sh can walk the import closure.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { runProbe } from './models-probe.mjs';
import { mintBedrockBearerToken } from './bedrock-token.mjs';

const s3 = new S3Client({});

// Same resolution as index.mjs, which throws at load when neither is set —
// AgentCore reserves ARTIFACT_BUCKET, so the hub's own name comes first.
const BUCKET = process.env.ARTIFACTS_BUCKET || process.env.ARTIFACT_BUCKET;

let depsCache = null;

export async function buildDeps() {
  if (depsCache) return depsCache;
  const [{ BedrockClient, ListInferenceProfilesCommand },
    { BedrockRuntimeClient, ConverseCommand },
    { PricingClient, GetProductsCommand },
    agentcore] = await Promise.all([
    import('@aws-sdk/client-bedrock'),
    import('@aws-sdk/client-bedrock-runtime'),
    import('@aws-sdk/client-pricing'),
    import('@aws-sdk/client-bedrock-agentcore'),
  ]);
  const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, InvokeAgentRuntimeCommandCommand,
    StopRuntimeSessionCommand } = agentcore;

  const clients = new Map();
  const client = (Ctor, region) => {
    const key = `${Ctor.name}:${region}`;
    if (!clients.has(key)) clients.set(key, new Ctor({ region }));
    return clients.get(key);
  };

  const readStream = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };

  const deps = {
    env: process.env,
    log: console,
    now: () => new Date(),
    uuid: () => randomUUID(),

    async s3Get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        return { body: await res.Body.transformToString(), etag: res.ETag };
      } catch (e) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    // `IfMatch` makes every registry write conditional on the ETag the caller
    // read, which is what lets the reconcile lose a race with a human on /models
    // instead of overwriting them.
    s3Put(key, body, { ifMatch } = {}) {
      return s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json',
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
      }));
    },

    async listInferenceProfiles(region) {
      const bedrock = client(BedrockClient, region);
      const out = [];
      let nextToken;
      do {
        const res = await bedrock.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken }));
        out.push(...(res.inferenceProfileSummaries || []));
        nextToken = res.nextToken;
      } while (nextToken);
      return out;
    },

    // Mantle's model list is the OpenAI-shaped `/v1/models`, bearer-authed like
    // every other call to that endpoint.
    async mantleModels(region) {
      const token = await mintBedrockBearerToken(region);
      const res = await fetch(`https://bedrock-mantle.${region}.api.aws/openai/v1/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'OpenAI-Project': 'default' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`mantle /models http ${res.status}`);
      const body = await res.json();
      return body?.data || [];
    },

    // The Pricing API lives in us-east-1 only, whatever region we are billing.
    async getProducts(serviceCode, filters) {
      const pricing = client(PricingClient, 'us-east-1');
      const res = await pricing.send(new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters, MaxResults: 100 }));
      return (res.PriceList || []).map((p) => {
        try { return typeof p === 'string' ? JSON.parse(p) : p; } catch { return null; }
      }).filter(Boolean);
    },

    converse({ region, modelId, maxTokens, text }) {
      return client(BedrockRuntimeClient, region).send(new ConverseCommand({
        modelId,
        messages: [{ role: 'user', content: [{ text }] }],
        inferenceConfig: { maxTokens },
      }));
    },

    mintToken: (region) => mintBedrockBearerToken(region),

    async httpPost({ url, headers, body, timeoutMs }) {
      const res = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 30_000),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep the raw text for the error */ }
      return { status: res.status, body: parsed, text };
    },

    async invokeCodingTurn({ runtimeArn, sessionId, payload }) {
      const res = await client(BedrockAgentCoreClient, process.env.AWS_REGION).send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        runtimeSessionId: sessionId,
        qualifier: 'DEFAULT',
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));
      const text = res.response ? await readStream(res.response) : '';
      try { return JSON.parse(text); } catch { return { raw: text }; }
    },

    // The commands API runs a shell command INSIDE the session's own container —
    // the only way to see what the CLI actually left on disk (DL-026). The
    // response is an event stream of stdout/stderr deltas terminated by a
    // contentStop carrying the exit code.
    async runCommand({ runtimeArn, sessionId, command, timeoutMs }) {
      const res = await client(BedrockAgentCoreClient, process.env.AWS_REGION)
        .send(new InvokeAgentRuntimeCommandCommand({
          agentRuntimeArn: runtimeArn,
          runtimeSessionId: sessionId,
          qualifier: 'DEFAULT',
          body: { command, timeout: Math.round((timeoutMs || 30_000) / 1000) },
        }));
      let stdout = '';
      let stderr = '';
      let exitCode = null;
      let status = null;
      for await (const event of res.stream || []) {
        const chunk = event?.chunk;
        if (!chunk) continue;
        if (chunk.contentDelta?.stdout) stdout += Buffer.from(chunk.contentDelta.stdout).toString('utf8');
        if (chunk.contentDelta?.stderr) stderr += Buffer.from(chunk.contentDelta.stderr).toString('utf8');
        if (chunk.contentStop) {
          exitCode = chunk.contentStop.exitCode ?? null;
          status = chunk.contentStop.status ?? null;
        }
      }
      return { stdout, stderr, exitCode, status };
    },

    stopSession({ runtimeArn, sessionId }) {
      return client(BedrockAgentCoreClient, process.env.AWS_REGION).send(new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn, runtimeSessionId: sessionId, qualifier: 'DEFAULT',
      }));
    },
  };

  // The reconcile's autoAdopt gate runs the CLI probe through the probe module,
  // but deliberately NOT through its handler: `runProbe` does not write
  // config/models.json, so the reconcile keeps its single conditional write.
  deps.probeCli = (row) => runProbe(row, 'cli', deps);
  depsCache = deps;
  return deps;
}
