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

/** `<base>-YYYYMMDD` with an optional `-vN[:M]` tail — the dated snapshot form. */
export const DATED_ID_RE = /^(.*)-\d{8}(?:-v\d+(?::\d+)?)?$/;

/** The one prefix whose rows own the bare CLI alias. `global.*` twins do not:
 *  discovery lists both for a new model, and deriving for both would make every
 *  new alias ambiguous and give it to neither (TEAM-5065). */
const BARE_ALIAS_PREFIX = "us.anthropic.";

/**
 * The bare name Claude Code puts in `gen_ai.request.model` for an inference
 * profile id: strip `us.anthropic.`, then a `-vN[:M]` version tail, then an
 * 8-digit `-YYYYMMDD` date stamp (`us.anthropic.<name>-<date>-v1:0` -> `<name>`).
 * null when the id is not a `us.anthropic.*` profile or the result is not a
 * valid, different id.
 */
export function deriveBareAlias(modelId: string): string | null {
  if (!modelId.startsWith(BARE_ALIAS_PREFIX)) return null;
  const bare = modelId
    .slice(BARE_ALIAS_PREFIX.length)
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
  if (!bare || bare === modelId || !MODEL_ID_RE.test(bare)) return null;
  return bare;
}

/**
 * Candidate id -> bare alias, for the candidates whose alias is unambiguous.
 * `taken` is every name the registry already resolves (row ids, row aliases,
 * legacyAliases keys); the batch's own ids are added here. An alias that is taken,
 * or that two candidates in the batch both derive, goes to no one — a wrong
 * alias misprices spans, a missing one only leaves them unpriced.
 */
export function assignBareAliases(candidateIds: readonly string[], taken: ReadonlySet<string>): Map<string, string> {
  const claimed = new Set([...taken, ...candidateIds]);
  const derived = new Map<string, string>();
  const count = new Map<string, number>();
  for (const id of candidateIds) {
    const alias = deriveBareAlias(id);
    if (!alias) continue;
    derived.set(id, alias);
    count.set(alias, (count.get(alias) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [id, alias] of derived) {
    if (count.get(alias) === 1 && !claimed.has(alias)) out.set(id, alias);
  }
  return out;
}
