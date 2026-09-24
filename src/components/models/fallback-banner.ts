/**
 * The /models banner for a registry read that is NOT the live document
 * (TEAM-5052). Pure, so the copy is unit-tested without a DOM.
 *
 * Without it the page showed the bundled seed's "version 1" as if it were live,
 * and nothing on screen said the S3 document had been refused — the operator
 * could not tell a quiet catalog from a broken one.
 */

import type { RegistryResponse } from "./types";

export function registryFallbackBanner(
  resp: Pick<RegistryResponse, "registry" | "source" | "fallback">
): string | null {
  if (!resp.source || resp.source === "s3") return null;
  const what = resp.source === "seed" ? "the bundled seed" : "the last good copy";
  const fb = resp.fallback;

  let why = "the live registry could not be read";
  if (fb?.reason === "invalid") {
    const live = fb.refusedVersion !== undefined ? `live version ${fb.refusedVersion}` : "the live document";
    why = `${live} was refused by validation (${fb.detail})`;
  } else if (fb?.reason === "missing") {
    why = "there is no live registry in S3 yet";
  } else if (fb?.reason === "error") {
    why = `the live registry could not be read (${fb.detail})`;
  } else if (fb?.reason === "no_bucket") {
    why = "ARTIFACT_BUCKET is not set, so there is no live registry";
  }

  // Probes and catalog refreshes refuse to write over a fallback. An operator
  // Save can replace a refused document only when there is no stale ETag in the
  // way, i.e. on the seed.
  const repair =
    resp.source === "seed" && (fb?.reason === "invalid" || fb?.reason === "missing")
      ? " Saving a valid registry here replaces it."
      : "";
  return (
    `Showing ${what} (version ${resp.registry.version}), not the live registry: ${why}. ` +
    `Probe results and catalog refreshes are not recorded until it is repaired.${repair}`
  );
}
