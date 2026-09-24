/**
 * The model-id SHAPE, shared by the server registry and the client page
 * (TEAM-5011).
 *
 * ZERO IMPORTS ON PURPOSE, same rationale as `src/lib/workflow/redact.ts`: this
 * is imported by both `src/lib/models-registry.ts` (server-only, pulls in the
 * AWS SDK) and `src/components/models/types.ts` (client, deliberately
 * self-contained), so it may not pull in either — a shared dependency here
 * would drag the AWS SDK into the client bundle or force the client file to
 * duplicate the regex again, which is the drift this file exists to end.
 *
 * `MODEL_ID_RE` / `isValidModelId` used to be defined twice (models-registry.ts
 * and types.ts); `PROFILE_ID_RE` / `MANTLE_ID_RE` lived only in discovery.ts.
 * All four now live here once, and `isDiscoverableModelId` is the intake
 * predicate behind TEAM-5011's decision (see catalog/route.ts): discovery is
 * the ONLY way a model id becomes a catalog row, so an id this returns false
 * for will never get a row of its own — at best it is an alias on the row of
 * the profile that actually serves it.
 */

/**
 * A model id is an opaque token we hand to an AWS API, an env var and a shell
 * command line. Anchored and character-bounded so an injected `;` or space can
 * never reach any of the three.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id);
}

/** Only ids the two listings can actually return are candidates for retirement. */
export const PROFILE_ID_RE = /^(us|global)\.(anthropic|openai)\.[A-Za-z0-9._:-]+$/;
export const MANTLE_ID_RE = /^openai\.[A-Za-z0-9._:-]+$/;

/**
 * Would a successful account sweep (`listInferenceProfiles` + `listMantleModels`)
 * list this id? This is the *intake* predicate (TEAM-5011): a model enters the
 * catalog only through discovery, so an id this returns `false` for is never
 * going to get a row of its own, no matter how many spans it appears in. A bare
 * CLI short name (`claude-opus-6`) and a bare Anthropic foundation-model id
 * with no `us.*`/`global.*` prefix both fail this — the former because the
 * fleet only ever discovers the inference profile that serves it, the latter
 * because it is never returned by either listing at all.
 */
export function isDiscoverableModelId(id: string): boolean {
  return PROFILE_ID_RE.test(id) || MANTLE_ID_RE.test(id);
}
