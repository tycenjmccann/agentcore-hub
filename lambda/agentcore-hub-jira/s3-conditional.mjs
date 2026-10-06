/**
 * TEAM-5167 R2-06: does this @aws-sdk/client-s3 actually put the conditional headers
 * on the wire?
 *
 * report_completion's create-once claims (index.mjs: claimCreateOnce and friends) are
 * PutObject with `IfNoneMatch:"*"` / `IfMatch:<etag>` and DeleteObject with `IfMatch`.
 * client-s3 learned those inputs in 3.635.0 (IfNoneMatch on PutObject, 2024-08-20),
 * 3.698.0 (conditional DeleteObject, 2024-11-21) and 3.700.0 (IfMatch on PutObject,
 * 2024-11-25). An older SDK does not reject the inputs — it silently drops them, and
 * every claim then "wins", which is exactly the duplicate the claims exist to stop.
 * The Lambda used to import client-s3 from the runtime, whose SDK minor version varies
 * by runtime and Region; it is now bundled and pinned (package.json), and this probe is
 * the fail-closed check behind the pin.
 *
 * The probe builds a throwaway client whose request handler captures the serialized
 * HTTP request and throws before any I/O — no network, static dummy credentials — and
 * sends one command per header. Three verdicts:
 *
 *   ok            every header was serialized with the value it was given
 *   missing       the serializer ran and at least one header is absent — FAIL CLOSED
 *   inconclusive  the probe could not see a serializer at all (a mocked client with no
 *                 middleware stack, a send() that never reaches the handler, a client
 *                 that cannot be constructed) — the caller changes nothing
 *
 * `inconclusive` is deliberately not `missing`: every vitest suite that mocks the SDK
 * at the module seam must keep exercising the claims as before.
 */
import { createRequire } from "node:module";

const PROBE_BUCKET = "agentcore-hub-conditional-header-probe";
const PROBE_KEY = "conditional-header-probe.json";
const PROBE_ETAG = '"conditional-header-probe"';

/** One row per header the claims depend on, in the order they are reported. */
export const PROBE_CASES = [
  { label: "PutObject If-None-Match", command: "PutObjectCommand", header: "if-none-match", expected: "*",
    input: { Bucket: PROBE_BUCKET, Key: PROBE_KEY, Body: "{}", ContentType: "application/json", IfNoneMatch: "*" } },
  { label: "PutObject If-Match", command: "PutObjectCommand", header: "if-match", expected: PROBE_ETAG,
    input: { Bucket: PROBE_BUCKET, Key: PROBE_KEY, Body: "{}", ContentType: "application/json", IfMatch: PROBE_ETAG } },
  { label: "DeleteObject If-Match", command: "DeleteObjectCommand", header: "if-match", expected: PROBE_ETAG,
    input: { Bucket: PROBE_BUCKET, Key: PROBE_KEY, IfMatch: PROBE_ETAG } },
];

/** The bundled client-s3 version, for the log line; null if it cannot be read. */
function sdkVersionOf() {
  try {
    return createRequire(import.meta.url)("@aws-sdk/client-s3/package.json").version ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe the SDK module `sdk` (`{ S3Client, PutObjectCommand, DeleteObjectCommand }` —
 * normally `import * as sdk from "@aws-sdk/client-s3"`). Never throws.
 *
 * @returns {Promise<{ verdict: "ok"|"missing"|"inconclusive", missing: string[], seen: Array<{label, header, expected, headers}>, sdkVersion: string|null, reason?: string }>}
 */
export async function probeConditionalHeaders(sdk) {
  const sdkVersion = sdkVersionOf();
  const inconclusive = (reason, seen = []) => ({ verdict: "inconclusive", reason, missing: [], seen, sdkVersion });
  try {
    const captured = [];
    const requestHandler = {
      // Called with the fully serialized + signed request. Throwing here is what keeps
      // the probe off the network; the name is how the send() catch below recognizes it.
      handle: async (request) => {
        captured.push(request);
        throw Object.assign(new Error("conditional-header probe: request captured before I/O"), { name: "ProbeCaptured" });
      },
      metadata: { handlerProtocol: "http/1.1" },
      updateHttpClientConfig() {},
      httpHandlerConfigs() { return {}; },
      destroy() {},
    };
    const { S3Client } = sdk;
    if (typeof S3Client !== "function") return inconclusive("sdk has no S3Client");
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAPROBEPROBEPROBE0", secretAccessKey: "probe-secret-never-sent" },
      requestHandler,
      maxAttempts: 1,
    });
    if (!client || typeof client.send !== "function" || !client.middlewareStack) {
      return inconclusive("client has no middleware stack to serialize through (not a real SDK client)");
    }
    const seen = [];
    const missing = [];
    for (const c of PROBE_CASES) {
      const Command = sdk[c.command];
      if (typeof Command !== "function") return inconclusive(`sdk has no ${c.command}`, seen);
      const before = captured.length;
      try {
        await client.send(new Command(c.input));
      } catch {
        // ProbeCaptured is the expected way out; any other error is judged by whether
        // the handler saw the request at all.
      }
      const request = captured[before];
      if (!request) return inconclusive(`send() never reached the request handler for ${c.label}`, seen);
      const headers = {};
      for (const [k, v] of Object.entries(request.headers || {})) {
        if (/^if-/i.test(k)) headers[k.toLowerCase()] = v;
      }
      seen.push({ label: c.label, header: c.header, expected: c.expected, headers });
      if (headers[c.header] !== c.expected) missing.push(c.label);
    }
    try { client.destroy?.(); } catch { /* nothing to release */ }
    return { verdict: missing.length ? "missing" : "ok", missing, seen, sdkVersion };
  } catch (err) {
    return inconclusive(`${err?.name || "Error"}: ${err?.message || "no message"}`);
  }
}
