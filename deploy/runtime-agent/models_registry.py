"""One model registry — the Python twin (TEAM-4995, DL-033).

Every model id used to live in a hardcoded alias map: `CODING_MODEL_TIERS` and
`MODEL_ALIASES` in this runtime's main.py, `modelMap` in the orchestrator, a
literal default in every setup script. Adding or retiring a model meant editing
all of them, and nothing could tell you which id a tier actually resolved to.

Now there is ONE document — `config/models.json` in the artifact bucket — and
this module is the only thing on the Python side that reads it:

    registry = load_registry()                          # one S3 GET, or None
    model_id = resolve_agent_model(registry, agent_id)   # persona / board model
    model_id, endpoint, region, api, ctx = resolve_coding_model(registry, "sol", "codex")

BYTE-IDENTICAL TWIN. This file is copied verbatim to
`deploy/coding-agent-runtime/models_registry.py` and `cmp`-pinned by
`scripts/check-models-registry-parity.sh` — the established pattern for
zero-import modules shared across deploy targets (cd-registry.mjs x3,
si-ledger.mjs x2, fix-contract.mjs). Edit ONE and copy, never both by hand.
Nothing here may import from main.py, and only `load_registry` may touch boto3,
because the `--export` CLI has to run inside `run-codex.sh` before anything else
is set up.

NO CACHE BY DEFAULT. `load_registry()` does one S3 GET per call — the same
hot-reload contract as `_load_connector_registry` (runtime-agent/main.py): a
warm microVM is reused across sessions, and a model promoted between two
invocations must be visible on the next one without a redeploy. Callers that
genuinely cannot afford the GET pass `ttl_seconds`.

EVERY resolution failure is LOUD and then falls back to a literal. A registry
that cannot be read or does not validate must never silently change which model
runs: it degrades to the env var, then to the one literal per role below.
"""

import json
import logging
import os
import re
import shlex
import sys

logger = logging.getLogger("models-registry")

# ─── Contracts ───────────────────────────────────────────────────────────────

# A model id is an opaque token we hand to Bedrock, an OpenAI-compatible
# endpoint, or a CLI's --model flag. It is validated, never sanitized: the
# `--export` path interpolates it into a shell eval and merge-codex-config.py
# into a TOML file, so a value that is not this shape is rejected outright.
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$")

# us-east-1 / us-gov-west-1 / ap-southeast-2. Also interpolated into a URL and a
# shell eval, hence the same treat-as-hostile rule.
REGION_RE = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-\d$")

# A dated duplicate of a model already in the catalog: `...-20251001`, with an
# optional `-v1` / `-v1:0` suffix. These appear when a provider publishes a
# snapshot id alongside the rolling one; both name the same model, so the
# catalog keeps the base id and the dated form resolves to it.
DATED_DUPLICATE_RE = re.compile(r"^(.*)-\d{8}(-v\d+(:\d+)?)?$")

# The last line of defence, used when there is no registry AND no env var. One
# per role — not a tier map. Keeping a tier map here would recreate exactly the
# drift this ticket deletes.
LITERAL_PERSONA = "us.anthropic.claude-fable-5-1"
LITERAL_CODING_CLAUDE = "us.anthropic.claude-fable-5-1"
LITERAL_CODING_CODEX = "openai.gpt-5.5"

# Endpoint defaults for the literal/env fallback path, where no catalog row
# exists to read them from. Claude speaks Converse on Bedrock Runtime; Codex
# speaks the OpenAI Responses API and (for the literal gpt-5.5) only Mantle has
# it, which is why the two roles have different homes.
_DEFAULT_CLAUDE_ENDPOINT = "bedrock-runtime"
_DEFAULT_CLAUDE_API = "converse"
_DEFAULT_CODEX_ENDPOINT = "bedrock-mantle"
_DEFAULT_CODEX_API = "responses"
_DEFAULT_CONTEXT_WINDOW = 400000

# Codex config numbers, public because both containers' config writers read them
# (see codex_config_fragment). GPT-5 class: 400k context, 128k max output — codex
# ships no metadata for these ids over Bedrock, so it warns and falls back to
# conservative defaults unless the limits are declared.
CODEX_MAX_OUTPUT_TOKENS = 128000
CODEX_DEFAULT_CONTEXT_WINDOW = _DEFAULT_CONTEXT_WINDOW
# An account setting, not a model property, so the caller passes it in.
CODEX_DEFAULT_PROJECT = "default"

# Agents that legitimately appear in `agents` but not in src/config/agents.json:
# the Telegram bug-intake bridge is a Lambda, not a fleet runtime, so it has no
# roster row — but it does pick a model, so it needs a pin.
EXEMPT_AGENTS = ("telegram_intake",)

_RESOLVABLE_STATUSES = ("active", "candidate")
_REGISTRY_KEY = "config/models.json"

_UNSET = object()
_CACHE = {"doc": _UNSET, "at": 0.0}


def reset_cache():
    """Drop the opt-in TTL cache. Tests call this; production does not need it."""
    _CACHE["doc"] = _UNSET
    _CACHE["at"] = 0.0


def _bucket():
    """The artifact bucket, under either spelling.

    AgentCore reserves `ARTIFACT_BUCKET` as a system env var on the fleet
    runtime (it points at the CodeBuild source bucket), so that deployment uses
    `AGENTCORE_HUB_ARTIFACT_BUCKET` — see runtime-agent/main.py. The coding
    runtime has no such collision and uses the plain name. One module serves
    both, so it reads both, hub-specific name first.
    """
    return os.environ.get("AGENTCORE_HUB_ARTIFACT_BUCKET") or os.environ.get("ARTIFACT_BUCKET") or ""


def _region():
    return os.environ.get("AWS_REGION") or "us-east-1"


# ─── Validation ──────────────────────────────────────────────────────────────

def _row_ok(row):
    """A catalog row is usable when it has a well-formed id and a sane status."""
    if not isinstance(row, dict):
        return False
    model_id = row.get("modelId")
    if not isinstance(model_id, str) or not MODEL_ID_RE.match(model_id):
        return False
    status = row.get("status", "active")
    if status not in ("active", "candidate", "retired", "quarantined"):
        return False
    region = row.get("region")
    if region is not None and not (isinstance(region, str) and REGION_RE.match(region)):
        return False
    aliases = row.get("aliases", [])
    if aliases is not None and not isinstance(aliases, list):
        return False
    return True


def parse_registry(doc):
    """Tolerant NORMALIZE of a registry document, with no verdict attached.

    Returns `(doc_or_None, warnings)`. Mirror of parseModelsRegistry() in
    src/lib/models-registry.ts, and the reason that function and validateRegistry()
    are two functions there rather than one: normalizing (drop malformed rows,
    de-duplicate aliases, fold dated snapshots) answers "what does this document
    say", while validating answers "may the hub serve it". A caller that wants to
    resolve THROUGH a document the read gate would refuse — a registry that
    quarantines a model some tier still points at, say — needs the first without
    the second. Only `load_registry` wants the verdict, and it calls
    validate_registry.
    """
    normalized, warnings, _errors = _parse_registry(doc)
    return normalized, warnings


def validate_registry(doc, agents_path=None):
    """Tolerant parse of a registry document, PLUS the hub's read-time verdict.

    Returns `(doc_or_None, warnings, errors)`, where `errors` is a
    `{field path: reason}` map in the SAME vocabulary as validateRegistry() in
    src/lib/models-registry.ts — `bad_model_id`, `quarantined`, `unknown_model`,
    `read_only`, `inactive`, `unpriced`, `unprobed`, `duplicate_alias`. The hub
    calls that function on its READ path (`registryReadFailure`) and falls back
    to last-good/seed on any of those reasons, so a twin that keeps serving a
    document the hub refuses IS the divergence DL-033 exists to prevent. Same
    reasons, same paths, same verdict.

    A malformed ROW is dropped with a warning — one bad candidate must not take
    the fleet down. But a document whose `defaults`, `tiers`, `agents` or
    `legacyAliases` point AT a row that cannot be routed to — dropped, retired,
    quarantined, read-only, unpriced, or a candidate that has not passed both
    probe planes — is internally inconsistent: resolving through it would
    silently hand back something other than what the operator wrote, so the
    whole document is an error and the caller falls back to env/literal instead.
    That asymmetry is the point.
    """
    normalized, warnings, errors = _parse_registry(doc)
    if normalized is None:
        return None, warnings, errors

    rows = normalized["models"]
    alias_owner = normalized["_aliasOwner"]
    legacy = doc.get("legacyAliases") if isinstance(doc.get("legacyAliases"), dict) else {}

    # Anything the document POINTS AT must be ROUTABLE, not merely present.
    # `defaults` and `tiers` are how every caller lands somewhere when it was
    # given nothing, so a target that cannot be routed to is not a warning.
    # _target_reason is the mirror of targetReason() in the canonical.
    index = _index_rows(rows, alias_owner)
    quarantine = _quarantine_set(doc)

    defaults = doc.get("defaults") if isinstance(doc.get("defaults"), dict) else {}
    for key, value in defaults.items():
        reason = _target_reason(index, quarantine, value)
        if reason:
            errors[f"defaults.{key}"] = reason

    tiers = doc.get("tiers") if isinstance(doc.get("tiers"), dict) else {}
    for cli, mapping in tiers.items():
        if not isinstance(mapping, dict):
            errors[f"tiers.{cli}"] = "not_an_object"
            continue
        for tier, value in mapping.items():
            reason = _target_reason(index, quarantine, value)
            if reason:
                errors[f"tiers.{cli}.{tier}"] = reason

    agents = doc.get("agents") if isinstance(doc.get("agents"), dict) else {}
    for agent_id, value in agents.items():
        reason = _target_reason(index, quarantine, value)
        if reason:
            errors[f"agents.{agent_id}"] = reason

    for alias, value in legacy.items():
        if not isinstance(alias, str) or not MODEL_ID_RE.match(alias):
            errors[f"legacyAliases.{alias}"] = "bad_model_id"
            continue
        reason = _target_reason(index, quarantine, value)
        if reason:
            errors[f"legacyAliases.{alias}"] = reason

    # Every pinned agent must be a real agent. Skipped entirely when the roster
    # is not readable from here — agents.json is NOT shipped into either Python
    # container, so absence is the normal case at runtime and only CI (which
    # passes a path) enforces this.
    roster = _read_roster(agents_path)
    if roster is not None:
        for agent_id in agents:
            if agent_id not in roster and agent_id not in EXEMPT_AGENTS:
                errors[f"agents.{agent_id}"] = "unknown_agent"

    if errors:
        return None, warnings, errors
    return normalized, warnings, errors


def _parse_registry(doc):
    """The normalize half, shared by both entry points above.

    `(doc_or_None, warnings, errors)`, where `errors` carries only the STRUCTURAL
    and catalog-integrity reasons — the document still normalizes with them, which
    is why parse_registry can hand it back and validate_registry cannot.
    """
    warnings, errors = [], {}
    if not isinstance(doc, dict):
        return None, warnings, {"document": "not_an_object"}

    raw_models = doc.get("models")
    if raw_models is None:
        raw_models = doc.get("catalog")
    if not isinstance(raw_models, list):
        return None, warnings, {"models": "missing_or_not_an_array"}

    rows, seen_ids, alias_owner = [], set(), {}
    for idx, row in enumerate(raw_models):
        if not _row_ok(row):
            warnings.append(f"row {idx} dropped (malformed)")
            continue
        model_id = row["modelId"]
        if model_id in seen_ids:
            warnings.append(f"row {idx} dropped (duplicate modelId {model_id})")
            continue
        seen_ids.add(model_id)
        # A COPY, matching `rows.push({...row})` in the mjs twin: the alias and
        # dated-fold passes below rewrite `aliases`, and doing that to the
        # caller's dict made parsing the same document twice give two answers.
        rows.append(dict(row))

    # Aliases must be unambiguous ACROSS namespaces: an alias that another row
    # already claims as its id or its alias makes resolution order decide which
    # model — and therefore which price — you get. The canonical errors on that
    # (`catalog.<id>.aliases.<alias>`), so this does too.
    #
    # An alias that collides with a legacyAliases KEY is the one case that stays
    # a dropped-with-a-warning: the canonical ignores legacy collisions, and
    # dropping the alias leaves the row reachable by id, so refusing the whole
    # document over a compatibility shim would be stricter than the hub.
    legacy = doc.get("legacyAliases") if isinstance(doc.get("legacyAliases"), dict) else {}
    claimed = {row["modelId"]: row["modelId"] for row in rows}
    for row in rows:
        kept = []
        for alias in (row.get("aliases") or []):
            if not isinstance(alias, str) or not MODEL_ID_RE.match(alias):
                errors[f"catalog.{row['modelId']}.aliases.{alias}"] = "bad_model_id"
                warnings.append(f"alias {alias!r} dropped (malformed)")
                continue
            owner = claimed.get(alias)
            if owner is not None and owner != row["modelId"]:
                errors[f"catalog.{row['modelId']}.aliases.{alias}"] = "duplicate_alias"
                warnings.append(f"alias {alias!r} dropped (ambiguous)")
                continue
            if alias in legacy:
                warnings.append(f"alias {alias!r} dropped (ambiguous)")
                continue
            claimed[alias] = row["modelId"]
            alias_owner[alias] = row["modelId"]
            kept.append(alias)
        row["aliases"] = kept

    # A dated snapshot of a model already in the catalog is the same model. Keep
    # the base id canonical and let the dated form resolve to it as an alias —
    # UNLESS something routes at the dated id, in which case routing outranks
    # tidiness and the row stays a row. Folding a routing target would make
    # `tiers.claude.sonnet` resolve to a different model than the operator wrote.
    targets = _routing_targets(doc)
    for row in list(rows):
        m = DATED_DUPLICATE_RE.match(row["modelId"])
        if row["modelId"] in targets:
            continue
        if m and m.group(1) in seen_ids and m.group(1) != row["modelId"]:
            base = next(r for r in rows if r["modelId"] == m.group(1))
            if row["modelId"] not in alias_owner:
                base.setdefault("aliases", []).append(row["modelId"])
                alias_owner[row["modelId"]] = base["modelId"]
            warnings.append(f"row {row['modelId']} folded into {m.group(1)} (dated duplicate)")
            rows.remove(row)
            seen_ids.discard(row["modelId"])

    normalized = dict(doc)
    normalized["models"] = rows
    normalized["_aliasOwner"] = alias_owner
    return normalized, warnings, errors


def _routing_targets(doc):
    """Every model id the document ROUTES at: defaults, tiers, agents, legacyAliases.

    Mirror of routingTargets() in src/lib/models-registry.ts. A dated duplicate
    that something routes at is kept; one nothing routes at is noise.
    """
    targets = set()
    if not isinstance(doc, dict):
        return targets
    for key in ("defaults", "agents", "legacyAliases"):
        mapping = doc.get(key)
        if isinstance(mapping, dict):
            targets.update(v for v in mapping.values() if isinstance(v, str) and v)
    tiers = doc.get("tiers")
    if isinstance(tiers, dict):
        for mapping in tiers.values():
            if isinstance(mapping, dict):
                targets.update(v for v in mapping.values() if isinstance(v, str) and v)
    return targets


def _index_rows(rows, alias_owner):
    """`(by_id, by_alias)` over the KEPT rows — the twin's RegistryIndex."""
    by_id = {row["modelId"]: row for row in rows}
    by_alias = {}
    for alias, owner in alias_owner.items():
        row = by_id.get(owner)
        if row is not None:
            by_alias[alias] = row
    return by_id, by_alias


def _quarantine_set(doc):
    quarantine = doc.get("quarantine") if isinstance(doc, dict) else None
    if not isinstance(quarantine, (list, tuple)):
        return set()
    return {v for v in quarantine if isinstance(v, str)}


def price_block_of(row):
    """A row's price block under either spelling: `price` canonical, `pricing` tolerated.

    Mirror of priceBlockOf() in the mjs twin. The registry writes `price`; older
    hand-edited documents and the pre-DL-033 pricing file used `pricing`, and a
    read path that only knew one spelling would call a priced model unpriced and
    refuse the whole document.
    """
    if not isinstance(row, dict):
        return None
    for key in ("price", "pricing"):
        block = row.get(key)
        if isinstance(block, dict):
            return block
    return None


def _priced_ok(price):
    """Mirror of pricedOk(): both rates present, finite and non-negative."""
    if not isinstance(price, dict):
        return False
    for key in ("input", "output"):
        value = price.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if value != value or value in (float("inf"), float("-inf")) or value < 0:
            return False
    return True


def _target_reason(index, quarantine, value):
    """Why `value` cannot be routed to, or None when it can.

    Byte-for-byte the same reason vocabulary and the same ORDER as
    targetReason() in src/lib/models-registry.ts, because the hub rejects a live
    document for any of them on its read path. Order matters: a quarantined id
    reports `quarantined` even if it is also unpriced, so an operator reading the
    hub's error and the fleet's log sees one story.
    """
    by_id, by_alias = index
    if not isinstance(value, str) or not MODEL_ID_RE.match(value):
        return "bad_model_id"
    if value in quarantine:
        return "quarantined"
    row = by_id.get(value) or by_alias.get(value)
    if row is None:
        return "unknown_model"
    if row.get("readOnly"):
        return "read_only"
    status = row.get("status", "active")
    if status == "quarantined":
        return "quarantined"
    if status == "retired":
        return "inactive"
    if not _priced_ok(price_block_of(row)):
        return "unpriced"
    # BOTH planes, not either: a model that answers the API but not the coding
    # CLI is half-proven, and `or` here would let a single green probe adopt it.
    if status == "candidate":
        probe = row.get("probe") if isinstance(row.get("probe"), dict) else {}
        api = probe.get("api") if isinstance(probe.get("api"), dict) else {}
        cli = probe.get("cli") if isinstance(probe.get("cli"), dict) else {}
        if not (api.get("ok") and cli.get("ok")):
            return "unprobed"
    return None


def _read_roster(agents_path):
    """The set of agentIds in src/config/agents.json, or None if unreadable."""
    if not agents_path:
        return None
    try:
        with open(agents_path) as fh:
            doc = json.load(fh)
    except Exception:
        return None
    entries = doc if isinstance(doc, list) else doc.get("agents", [])
    if not isinstance(entries, list):
        return None
    return {e.get("agentId") for e in entries if isinstance(e, dict)}


# ─── Loading ─────────────────────────────────────────────────────────────────

def load_registry(ttl_seconds=0, agents_path=None):
    """Read config/models.json from S3. Returns the validated doc, or None.

    ONE GET PER CALL by default (ttl_seconds=0) — deliberately not cached across
    the container, exactly like `_load_connector_registry` in
    runtime-agent/main.py: a warm microVM serves many invocations, and a tier
    repointed by the nightly reconcile has to take effect on the next turn
    without a redeploy. It is one small GET per run that resolves a model.

    Never raises. Every failure path logs `[models] registry.fallback reason=…`
    and returns None, which every resolver below treats as "no tiers, no
    aliases, no catalog" so the env/literal chain still produces an answer.
    """
    import time
    if ttl_seconds > 0 and _CACHE["doc"] is not _UNSET and (time.time() - _CACHE["at"]) < ttl_seconds:
        return _CACHE["doc"]

    doc = None
    bucket = _bucket()
    if not bucket:
        logger.info("[models] registry.fallback reason=no-bucket")
    else:
        try:
            import boto3
            obj = boto3.client("s3", region_name=_region()).get_object(Bucket=bucket, Key=_REGISTRY_KEY)
            body = obj["Body"].read()
            etag = (obj.get("ETag") or "").strip('"')
            raw = json.loads(body)
            doc, warnings, errors = validate_registry(raw, agents_path)
            for w in warnings:
                logger.info(f"[models] registry.warn {w}")
            if errors:
                for path, reason in sorted(errors.items()):
                    logger.warning(f"[models] registry.error {path} reason={reason}")
                logger.warning("[models] registry.fallback reason=invalid")
                doc = None
            else:
                logger.info(
                    f"[models] registry.loaded source=s3 version={doc.get('version', 0)} "
                    f"rows={len(doc.get('models') or [])} etag={etag}"
                )
        except json.JSONDecodeError as e:
            logger.warning(f"[models] registry.fallback reason=parse ({e})")
            doc = None
        except Exception as e:
            logger.warning(f"[models] registry.fallback reason=s3 ({e})")
            doc = None

    if ttl_seconds > 0:
        _CACHE["doc"] = doc
        _CACHE["at"] = time.time()
    return doc


# ─── Resolution ──────────────────────────────────────────────────────────────

def _rows(registry):
    if not isinstance(registry, dict):
        return []
    rows = registry.get("models")
    return rows if isinstance(rows, list) else []


def _find_row(registry, name):
    """The catalog row whose modelId or alias is `name`, else None."""
    for row in _rows(registry):
        if row.get("modelId") == name:
            return row
        if name in (row.get("aliases") or []):
            return row
    return None


def row_for(registry, model_id):
    """Public lookup used by callers that need a row's endpoint/region/api."""
    return _find_row(registry, model_id)


def resolve_model(registry, name, cli=None):
    """Resolve a tier name, alias or raw id to a model id. None when unknown.

    Order (the design's algorithm, and the reason each step is where it is):
      1. `quarantine` — an operator kill switch has to beat every other source,
         including an explicit pin, or it is not a kill switch. Checked on the
         raw input AND again on the resolved id (step 4), because a tier word or
         a legacy alias must not be a way around it.
      2. `tiers[cli]` — tiers are CLI-scoped: "sol" means a Codex model to codex
         and nothing to claude, so an unscoped map would cross the wires.
      3. `legacyAliases` — yesterday's names ("claude-sonnet-45") keep working.
      4. the catalog, by modelId or alias, when the row is active/candidate.
      5. a retired/quarantined row: warn and return None so the CALLER falls
         through to its next precedence step. Resolving it anyway would keep a
         withdrawn model silently in service, which is the bug this replaces.
      6. passthrough for anything that looks like a model id (contains "."), so
         an id published after the last reconcile is still usable.
    """
    if not isinstance(name, str):
        return None
    name = name.strip()
    if not name:
        return None

    if _quarantined(registry, name):
        logger.warning(f"[models] registry.quarantined {name}")
        return None

    tiers = registry.get("tiers") if isinstance(registry, dict) else None
    if isinstance(tiers, dict):
        scoped = tiers.get("codex" if cli == "codex" else "claude")
        # EXACT case: tier words are document keys, not user prose. Case-folding
        # here made "OPUS" resolve on the fleet and not in the hub, which is the
        # kind of split the canonical exists to prevent.
        if isinstance(scoped, dict) and name in scoped:
            name = scoped[name]

    legacy = registry.get("legacyAliases") if isinstance(registry, dict) else None
    if isinstance(legacy, dict) and name in legacy:
        name = legacy[name]

    # The kill switch is re-checked on the RESOLVED id: quarantining a model must
    # not be bypassable by asking for its tier or one of its old names.
    if _quarantined(registry, name):
        logger.warning(f"[models] registry.quarantined {name}")
        return None

    row = _find_row(registry, name)
    if row is not None:
        status = row.get("status", "active")
        # An alias hit resolves to the row id, so the row id is what the kill
        # switch has to be checked against as well.
        if status == "quarantined" or _quarantined(registry, row["modelId"]):
            logger.warning(f"[models] registry.quarantined {row['modelId']}")
            return None
        if status in _RESOLVABLE_STATUSES:
            return row["modelId"]
        logger.warning(f"[models] registry.retired {row['modelId']} (status={status})")
        return None

    if "." in name and MODEL_ID_RE.match(name):
        return name
    return None


def _quarantined(registry, name):
    quarantine = registry.get("quarantine") if isinstance(registry, dict) else None
    return isinstance(quarantine, (list, tuple)) and name in quarantine


def _raw_env(registry, env):
    """An env-var model id we could not resolve, honoured as-is — unless it is
    quarantined. The env var is an operator override and outranks the catalog,
    but `quarantine` is a kill switch and outranks the operator."""
    if not env or not MODEL_ID_RE.match(env) or _quarantined(registry, env):
        return None
    return env


def resolve_agent_model(registry, agent_id, override=None):
    """The persona/board model for one agent.

    override -> agents[agent_id] -> defaults.persona -> $MODEL_ID -> literal.
    Each step is tried through `resolve_model`, so a tier name, a legacy alias
    or a retired id at any level falls through to the next rather than pinning
    something that no longer exists.
    """
    for candidate in (override, _pin(registry, agent_id), _default(registry, "persona")):
        resolved = resolve_model(registry, candidate)
        if resolved:
            return resolved
    env = (os.environ.get("MODEL_ID") or "").strip()
    if env:
        if resolved := (resolve_model(registry, env) or _raw_env(registry, env)):
            return resolved
    return LITERAL_PERSONA


def _pin(registry, agent_id):
    agents = registry.get("agents") if isinstance(registry, dict) else None
    return agents.get(agent_id) if isinstance(agents, dict) and agent_id else None


def _default(registry, key):
    defaults = registry.get("defaults") if isinstance(registry, dict) else None
    return defaults.get(key) if isinstance(defaults, dict) else None


def resolve_coding_model(registry, tier_or_id, cli):
    """Resolve a coding-CLI model to `(model_id, endpoint, region, api, context_window)`.

    argument -> defaults.codingClaude|codingCodex -> $ANTHROPIC_MODEL/$CLAUDE_MODEL
    (claude) or $CODEX_MODEL (codex) -> literal.

    The endpoint tuple is what makes Codex work on BOTH of its homes: Bedrock
    Runtime serves the inference-profile ids (`us.openai.gpt-…`) on
    `/openai/v1`, Mantle serves the bare ids (`openai.gpt-…`) on a different
    host, and only the catalog row knows which. When we fall back past the
    catalog there is no row to ask, so each role gets its documented default
    home — Claude/Converse on Bedrock Runtime, Codex/Responses on Mantle (the
    literal gpt-5.5 is Mantle-only).
    """
    codex = cli == "codex"
    default_key = "codingCodex" if codex else "codingClaude"
    for candidate in (tier_or_id, _default(registry, default_key)):
        resolved = resolve_model(registry, candidate, cli)
        if resolved:
            return _with_endpoint(registry, resolved, codex)

    env_names = ("CODEX_MODEL",) if codex else ("ANTHROPIC_MODEL", "CLAUDE_MODEL")
    for name in env_names:
        env = (os.environ.get(name) or "").strip()
        if env and (resolved := (resolve_model(registry, env, cli) or _raw_env(registry, env))):
            return _with_endpoint(registry, resolved, codex)

    return _with_endpoint(registry, LITERAL_CODING_CODEX if codex else LITERAL_CODING_CLAUDE, codex)


def _with_endpoint(registry, model_id, codex):
    """Attach endpoint/region/api/contextWindow, from the row when there is one."""
    row = _find_row(registry, model_id)
    if row is None:
        endpoint = _DEFAULT_CODEX_ENDPOINT if codex else _DEFAULT_CLAUDE_ENDPOINT
        api = _DEFAULT_CODEX_API if codex else _DEFAULT_CLAUDE_API
        region = _fallback_region(codex, endpoint)
        return model_id, endpoint, region, api, _DEFAULT_CONTEXT_WINDOW

    endpoint = row.get("endpoint") or (_DEFAULT_CODEX_ENDPOINT if codex else _DEFAULT_CLAUDE_ENDPOINT)
    api = row.get("api") or (_DEFAULT_CODEX_API if codex else _DEFAULT_CLAUDE_API)
    region = row.get("region")
    if not (isinstance(region, str) and REGION_RE.match(region)):
        if region:
            logger.warning(f"[models] registry.bad-region {region!r} for {model_id}")
        region = _fallback_region(codex, endpoint)
    ctx = row.get("contextWindow")
    if not isinstance(ctx, int) or ctx <= 0:
        ctx = _DEFAULT_CONTEXT_WINDOW
    return row["modelId"], endpoint, region, api, ctx


def _fallback_region(codex, endpoint):
    """Region when the row does not say. Mantle has its own env var — and it is
    MANTLE-ONLY: a bedrock-runtime model must never be handed the Mantle region,
    which is why this branches on the endpoint, not on the CLI."""
    mantle = endpoint == "bedrock-mantle"
    safe = "us-east-2" if mantle else "us-east-1"
    region = ((os.environ.get("BEDROCK_MANTLE_REGION") or "").strip() or safe) if mantle else _region()
    if not REGION_RE.match(region):
        logger.warning(f"[models] registry.bad-region {region!r} — using {safe}")
        return safe
    return region


def base_url_for(endpoint, region):
    """The OpenAI-compatible base URL for an endpoint + region."""
    if endpoint == "bedrock-mantle":
        return f"https://bedrock-mantle.{region}.api.aws/openai/v1"
    return f"https://bedrock-runtime.{region}.amazonaws.com/openai/v1"


# ─── Codex provider config ───────────────────────────────────────────────────
# ONE generator for the config.toml keys that are OURS. There were two, and they
# drifted: deploy/runtime-agent/main.py named the provider "Amazon Bedrock Runtime
# (OpenAI-compatible)" (codex's own name for the endpoint is not ours to invent),
# inlined the base URL instead of calling base_url_for, and carried its own copy
# of the output cap. This module is where it belongs: it is the only file both
# container images already have on the import path (/app/models_registry.py), it
# is stdlib-only by contract, and it already owns base_url_for and the context
# window. Callers are deploy/coding-agent-runtime/merge-codex-config.py (which
# merges the fragment into a user-supplied file) and the fleet runtime's
# _ensure_codex_config (which writes a whole fresh file).

def codex_config_fragment(model, base_url, endpoint, project=CODEX_DEFAULT_PROJECT,
                          context_window=CODEX_DEFAULT_CONTEXT_WINDOW):
    """-> (top-level keys, provider tables): the two TOML blocks that are OURS.

    Two blocks, not one string, because the top-level keys must be emitted BEFORE
    any [table] header — anything after one becomes a key OF that table — and a
    merging caller has to slot the user's surviving keys in between.
    """
    top = [
        f"model = {json.dumps(model)}",
        f"model_provider = {json.dumps(endpoint)}",
        f"model_context_window = {context_window}",
        f"model_max_output_tokens = {CODEX_MAX_OUTPUT_TOKENS}",
    ]
    if endpoint != "bedrock-mantle":
        # MANDATORY on bedrock-runtime. `codex exec --yolo` defaults web_search to
        # "live", and Bedrock answers a request carrying the web_search tool with
        # turn.failed "web search is not supported for this request" — i.e. every
        # turn dies. Mantle does not need it, which is why it is emitted here
        # only (design DD3b).
        top.append('web_search = "disabled"')

    name = ("Amazon Bedrock Mantle (OpenAI-compatible)" if endpoint == "bedrock-mantle"
            else "Amazon Bedrock (OpenAI-compatible)")
    tables = [
        f"[model_providers.{endpoint}]",
        f"name = {json.dumps(name)}",
        f"base_url = {json.dumps(base_url)}",
        'env_key = "OPENAI_API_KEY"',
        # GPT-5 class only supports /responses.
        'wire_api = "responses"',
    ]
    if endpoint == "bedrock-mantle":
        # Mantle REQUIRES the project header — "Engine not found" without it.
        tables += [
            "",
            f"[model_providers.{endpoint}.http_headers]",
            f"OpenAI-Project = {json.dumps(project)}",
        ]
    return "\n".join(top), "\n".join(tables)


def codex_config_text(model, base_url, endpoint, project=CODEX_DEFAULT_PROJECT,
                      context_window=CODEX_DEFAULT_CONTEXT_WINDOW):
    """A whole fresh config.toml — byte-identical to merging into an empty file."""
    top, tables = codex_config_fragment(model, base_url, endpoint, project, context_window)
    return "\n\n".join(block for block in (top, tables) if block) + "\n"


# ─── `--export` CLI ──────────────────────────────────────────────────────────
# run-codex.sh and shell-init.sh run BEFORE any Python of ours is importable as
# a module, so they source the resolution as shell:
#
#     eval "$(python3 /app/models_registry.py --export codex "${CODEX_MODEL:-}")"
#
# Every value is shlex.quote'd: a model id or region reaching an `eval` is the
# one place in this module where a bad value would be executed rather than just
# wrong, and MODEL_ID_RE/REGION_RE are checked before we get here.

def _export_lines(registry, cli, tier_or_id):
    model_id, endpoint, region, api, ctx = resolve_coding_model(registry, tier_or_id, cli)
    prefix = "CODEX" if cli == "codex" else "CLAUDE"
    pairs = [
        (f"{prefix}_RESOLVED_MODEL", model_id),
        (f"{prefix}_ENDPOINT", endpoint),
        (f"{prefix}_REGION", region),
        (f"{prefix}_API", api),
    ]
    if cli == "codex":
        pairs.append(("CODEX_BASE_URL", base_url_for(endpoint, region)))
        pairs.append(("CODEX_CONTEXT_WINDOW", str(ctx)))
    return [f"export {k}={shlex.quote(str(v))}" for k, v in pairs]


def main(argv):
    """`--export <cli> [cli…] [tier_or_id]` — print shell exports, always exit 0.

    Exit 0 even on failure: these exports are eval'd by a shell that is about to
    start a coding turn, and a non-zero exit there would kill the turn outright.
    A registry we could not read degrades to the literals instead, loudly (the
    warning goes to stderr, which the caller's logs capture).
    """
    if len(argv) < 2 or argv[0] != "--export":
        sys.stderr.write("usage: models_registry.py --export <claude|codex> [claude|codex] [tier_or_id]\n")
        return 2
    clis = [a for a in argv[1:] if a in ("claude", "codex")]
    rest = [a for a in argv[1:] if a not in ("claude", "codex")]
    if not clis:
        sys.stderr.write("usage: models_registry.py --export <claude|codex> [claude|codex] [tier_or_id]\n")
        return 2
    tier_or_id = rest[0] if rest else ""
    try:
        registry = load_registry()
    except Exception as e:  # noqa: BLE001 — load_registry already swallows, this is belt-and-braces
        sys.stderr.write(f"[models] registry.fallback reason=unexpected ({e})\n")
        registry = None
    for cli in clis:
        for line in _export_lines(registry, cli, tier_or_id):
            print(line)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(message)s")
    sys.exit(main(sys.argv[1:]))
