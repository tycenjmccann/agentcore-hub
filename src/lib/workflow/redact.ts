/**
 * Query-string redaction for anything a URL can reach a log line or an HTTP
 * response body through.
 *
 * An S3/CloudFront presigned URL carries its own credential: X-Amz-Signature +
 * X-Amz-Credential (or Signature + Key-Pair-Id + Policy) are a bearer token for
 * the object until they expire. Source validation echoes the submitted URL back
 * to the submitter in 422 details, into console warnings, and into the
 * `verification.detail` we persist on the workflow row — every one of those is a
 * place a live presigned URL must not land.
 *
 * The rule is deliberately blunter than an allow/deny list of parameter names:
 * ANY query-string value is dropped, so a new signing scheme (or a vendor's
 * `?auth=`) is covered without an edit here. Parameter NAMES are kept because
 * they are the useful diagnostic ("it was presigned, and it had an Expires").
 *
 * ZERO IMPORTS ON PURPOSE: this is imported by both the server-only validator
 * (src/lib/workflow/intake.ts, which pulls in @aws-sdk/client-s3) and the
 * client-bundled WorkflowBoard. Do not add a dependency to this file.
 */

/** URL-ish substrings — matched inside a larger string because undici error
 *  messages ("request to https://…?X-Amz-Signature=… failed") echo the URL. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi;

function redactQuery(urlLike: string): string {
  const q = urlLike.indexOf("?");
  if (q === -1) return urlLike;

  const base = urlLike.slice(0, q);
  const rest = urlLike.slice(q + 1);
  const hash = rest.indexOf("#");
  const query = hash === -1 ? rest : rest.slice(0, hash);
  const fragment = hash === -1 ? "" : rest.slice(hash);

  const redacted = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      // A bare flag has no value to leak — keep it verbatim.
      return eq === -1 ? pair : `${pair.slice(0, eq)}=REDACTED`;
    })
    .join("&");

  return `${base}?${redacted}${fragment}`;
}

/**
 * Replace every query-string VALUE in `value` with "REDACTED", keeping scheme,
 * host, path, parameter names and fragment. Input with no URL in it (or no
 * query string) is returned unchanged. Never throws.
 */
export function redactUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    return value.replace(URL_LIKE, (m) => redactQuery(m));
  } catch {
    // Unreachable for a plain string replace, but this function is called from
    // error paths — it must never be the thing that throws.
    return value;
  }
}
