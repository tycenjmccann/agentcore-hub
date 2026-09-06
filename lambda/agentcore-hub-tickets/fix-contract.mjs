/**
 * fix-contract.mjs — the shared fix-ticket contract (TEAM-4121 FR-8).
 *
 * A "fix ticket" is one an agent files against its own pipeline: the code
 * reviewer's review_fix, the QA verifier's qa_fix, the CI agent's ci_fix, and so
 * on. Historically the only thing such a ticket had to carry was
 * `spawned_by.kind`, which is enough for the orchestrator's completion gate to
 * SEE the fix but not nearly enough for the dev agent receiving it to KNOW what
 * it must make true. The result is the rework loop TEAM-4113 capped rather than
 * cured: a fix ticket saying "tests are failing" gets a change that makes some
 * test pass, QA disagrees, round two.
 *
 * The contract is the minimum an agent must state for a fix ticket to be
 * actionable and, crucially, VERIFIABLE by someone other than its author:
 *
 *   invariant        what must be true when the fix lands (the acceptance test,
 *                    in one sentence — not "fix the bug")
 *   evidence_source  how the author knows it is broken: static | unit | live
 *   evidence_repro   the exact command/steps that show it (required for
 *                    unit/live — a claim of a live failure with no repro is an
 *                    opinion)
 *   cited_location   file:line (or file:line-line) anchors, so the reader does
 *                    not have to re-find the defect
 *   sibling_scope    what the fix must NOT touch (optional, but the cheapest way
 *                    to stop a fix from growing into a refactor)
 *   origin           the ticket this fix was spawned from (F12) — the lineage
 *                    the rework cap counts rounds along
 *
 * ── Why this module has ZERO imports ────────────────────────────────────────
 * It is loaded by three separately-zipped Lambdas (agentcore-hub-tickets,
 * agentcore-hub-jira, orchestrator), two of which ship as self-contained
 * single-directory zips and therefore CANNOT share a file. The module is
 * duplicated byte-for-byte into each directory and CI byte-compares the copies.
 * Any import — even a local one — would have to be duplicated too, so there are
 * none: pure functions, plain data in, plain data out, no I/O, no AWS.
 * EDIT ONE COPY, THEN `cp` IT OVER THE OTHER TWO.
 *
 * ── F11: contract text is INERT DATA, never something shell-shaped ──────────
 * Every free-text field ends up in a ticket description, a Telegram message, an
 * agent prompt, and (via the coding CLIs) a place where a plausible-looking
 * command may be run. So: backticks and control characters are stripped from
 * every stored string, and `evidence_repro` — the ONE field that legitimately
 * looks like a command — is rejected outright if it contains shell composition
 * (`;` `&&` `||` `` ` `` `$(` `>`) or a newline. A repro is a single command a
 * human can read at a glance and decide to run; a pipeline of them is not
 * evidence, it is a script, and a fix ticket is not a place to smuggle one.
 *
 * ── F12: origin ids are shape-checked ──────────────────────────────────────
 * `spawned_by.<originKey>` is interpolated into JQL and DynamoDB keys and read
 * back as a ticket id. It must look like one: either a project key
 * (`TEAM-4089`) or a bare DynamoDB-mode id. Anything else is dropped by
 * sanitizeSpawnedBy and then reported missing by validateFixContract, so a
 * malformed origin can never reach a query builder.
 *
 * Modes (FIX_TICKET_CONTRACT): off = the fields are ignored entirely and ticket
 * creation is byte-identical to before this feature; shadow = validate, accept
 * anyway, persist what parsed plus a `warnings` list; enforce = reject an
 * incomplete contract and mint nothing. Fails safe to SHADOW on a garbage value
 * (validation that only logs costs nothing; refusing to file a fix ticket
 * because an env var was typo'd would wedge the pipeline).
 */

// The fix-ticket kinds an agent may stamp. Kept in lockstep with the
// orchestrator's completion.mjs FIX_KINDS (which recognizes the first three) —
// ship_fix/ci_fix/sync_fix are newer and carry their own origin keys.
export const FIX_KINDS = ["review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix"];

// The subset that counts as REWORK for loop-cap purposes. ci_fix/sync_fix are
// environmental (a red build, a branch that drifted from main) — they are not a
// reviewer disagreeing with a dev, so counting them as rework rounds would trip
// the cap on noise that no amount of code change makes converge.
export const REWORK_FIX_KINDS = ["review_fix", "qa_fix", "codex_fix", "ship_fix"];

// Which `spawned_by` key carries the origin ticket id for each kind. sync_fix
// shares ciTicketId: both are filed by the CI agent off the same build ticket.
export const KIND_TO_ORIGIN_KEY = {
  review_fix: "gateTicketId",
  qa_fix: "qaTicketId",
  codex_fix: "codexTicketId",
  ship_fix: "shipTicketId",
  ci_fix: "ciTicketId",
  sync_fix: "ciTicketId",
};

// Origin-id keys that survive sanitizeSpawnedBy (all shape-checked, F12).
export const SPAWN_ORIGIN_KEYS = ["gateTicketId", "qaTicketId", "codexTicketId", "shipTicketId", "ciTicketId"];

// Allow-listed non-origin `spawned_by` keys: reverify (boolean — this fix is a
// re-verification of an earlier one), rearmOf (the ticket whose gate is being
// re-armed), headSha (the commit the evidence was gathered against),
// priorFixTicketId + round (TEAM-4131 F1 — the fix ticket THIS one supersedes and
// which attempt this is, for the sync-main conflict rounds; the origin key stays
// ciTicketId, `priorFixTicketId` is lineage, not an origin).
export const SPAWN_EXTRA_KEYS = ["reverify", "rearmOf", "headSha", "priorFixTicketId", "round"];

// `round` is the one numeric member of a spawned_by marker. Capped so a hostile
// or buggy caller cannot write an arbitrary number onto the ticket record.
const MAX_SPAWN_ROUND = 99;

export const EVIDENCE_SOURCES = ["static", "unit", "live"];

export const CONTRACT_VERSION = 1;

// Label namespaces the system owns. A user/agent-supplied label starting with
// any of these is DROPPED rather than sanitized: these labels are read back as
// structured data (the orchestrator reconstructs spawnedBy.kind from `fix:`,
// dedupes runs on `wf:`, and routes human gates on `human-review`), so letting
// a caller mint one would let it forge provenance.
export const SYSTEM_LABEL_PREFIXES = [
  "fix:",
  "origin:",
  "evidence:",
  "phase:",
  "contract:",
  "reverify:",
  "agent:",
  "reviewer:",
  "wf:",
  "human-review",
  "ci:",
];

// TEAM-4131 F2 — labels that are RESERVED on some tickets rather than globally.
//
// `advisory` is read by the orchestrator as "backlog the run does not wait on":
// under ADVISORY_ROUTING=enforce, completion.mjs drops an advisory-labelled child
// out of EVERY completion gate. It is a legitimate user label on an ordinary
// backlog ticket, which is why it is not in SYSTEM_LABEL_PREFIXES. But on a FIX
// ticket it is a bypass: any agent (or a prompt-injected one) filing a real
// qa_fix with labels="advisory" would make the run finalize with that fix still
// open — the exact gate the fix exists to hold. Same for a `human:` gate ticket,
// whose whole purpose is to be waited on.
//
// So the word is dropped (and REPORTED as dropped) on those two ticket shapes,
// and passes through untouched everywhere else. This is the write-side half of a
// defense in depth: completion.mjs refuses to honour the label on those shapes
// even if one is already stored from before this guard existed.
export const RESERVED_ADVISORY_LABEL = "advisory";

export const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

// DynamoDB-mode ids (and rearmOf/headSha) — bare, bounded, no separators that
// mean anything to JQL or a shell.
const BARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// file:line or file:line-line. The path may not contain whitespace or a colon,
// so "src/a.ts:12" parses unambiguously and "see the handler" does not parse.
const CITED_LOCATION_RE = /^[^\s:]+:\d+(-\d+)?$/;

// Shell composition + a command substitution opener. `>` is included because a
// repro that redirects is a repro that writes.
const SHELL_COMPOSITION_RE = /[;`>\n\r]|&&|\|\||\$\(/;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const MAX_INVARIANT = 2000;
const MAX_REPRO = 1000;
const MAX_SIBLING_SCOPE = 500;
const MAX_LABEL = 64;

const OPEN_MARKER = "# fix-contract v1";
const CLOSE_MARKER = "# /fix-contract";

const KNOWN_MODES = ["off", "shadow", "enforce"];

/**
 * off | shadow | enforce. Unset/blank → "off" (a fresh deploy changes nothing).
 * A present-but-unrecognized value → "shadow", NOT off: the dangerous failure
 * direction here is refusing to file fix tickets, and shadow both validates and
 * accepts. (Note this is the opposite coalescing direction from the ship/gate
 * guards, where the dangerous failure is acting on bad state.)
 */
export function normalizeContractMode(v) {
  if (v === undefined || v === null) return "off";
  const s = String(v).trim().toLowerCase();
  if (s === "") return "off";
  if (KNOWN_MODES.includes(s)) return s;
  console.warn(`[fix-contract] FIX_TICKET_CONTRACT=${JSON.stringify(v)} is not off|shadow|enforce; coercing to SHADOW (validate + accept)`);
  return "shadow";
}

/** Strip control chars/backticks and flatten to a single trimmed line (F11). */
function oneLine(v) {
  return String(v)
    .replace(/`/g, "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Strip control chars/backticks but KEEP newlines (render-side hygiene). */
function stripControl(v) {
  return String(v).replace(/`/g, "").replace(CONTROL_CHARS_RE, "");
}

/** A non-empty string that looks like a ticket id (F12). */
function isOriginIdShape(v) {
  return typeof v === "string" && v.length > 0 && (TICKET_KEY_RE.test(v) || BARE_ID_RE.test(v));
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Validate an agent-supplied fix contract.
 *
 * Returns { ok, missing, invalid, contract }. `contract` is populated whenever
 * the invariant parses — even when `ok` is false — so SHADOW mode can persist
 * the partial contract alongside its warnings instead of throwing away the one
 * field that was filled in correctly.
 *
 * A ticket with no `spawned_by.kind` is not a fix ticket and is not subject to
 * the contract at all: { ok:true, contract:null }.
 */
export function validateFixContract(input = {}) {
  const {
    spawnedBy,
    invariant,
    evidence_source,
    evidence_repro,
    cited_location,
    sibling_scope,
    spawned_by_origin_id,
  } = input || {};

  const kind = spawnedBy && typeof spawnedBy === "object" && !Array.isArray(spawnedBy) ? spawnedBy.kind : null;
  if (!kind) return { ok: true, missing: [], invalid: [], contract: null };

  const missing = [];
  const invalid = [];

  // ── invariant (required) ─────────────────────────────────────────────────
  let invariantText = null;
  if (isBlank(invariant)) {
    missing.push("invariant");
  } else if (typeof invariant !== "string") {
    invalid.push("invariant");
  } else {
    invariantText = oneLine(invariant);
    if (invariantText === "") {
      // Non-blank input that sanitizes to nothing (all backticks/control chars).
      missing.push("invariant");
      invariantText = null;
    } else if (invariantText.length > MAX_INVARIANT) {
      // Report it, but keep the clipped text so shadow persists something useful.
      invalid.push("invariant");
      invariantText = invariantText.slice(0, MAX_INVARIANT);
    }
  }

  // ── evidence_source (required, enumerated) ───────────────────────────────
  let evidenceSource = null;
  if (isBlank(evidence_source)) {
    missing.push("evidence_source");
  } else if (typeof evidence_source !== "string") {
    invalid.push("evidence_source");
  } else {
    const src = evidence_source.trim().toLowerCase();
    if (EVIDENCE_SOURCES.includes(src)) evidenceSource = src;
    else invalid.push("evidence_source");
  }

  // ── evidence_repro (required for unit/live) ──────────────────────────────
  // Shape-checked whenever present, even for `static`: if it is stored at all it
  // must be inert (F11).
  let evidenceRepro = null;
  const reproRequired = evidenceSource === "unit" || evidenceSource === "live";
  if (isBlank(evidence_repro)) {
    if (reproRequired) missing.push("evidence_repro");
  } else if (typeof evidence_repro !== "string") {
    invalid.push("evidence_repro");
  } else if (evidence_repro.length > MAX_REPRO || SHELL_COMPOSITION_RE.test(evidence_repro)) {
    invalid.push("evidence_repro");
  } else {
    evidenceRepro = evidence_repro.trim();
  }

  // ── cited_location (required except for the environmental kinds) ─────────
  const locationRequired = ["review_fix", "codex_fix", "qa_fix", "ship_fix"].includes(kind);
  let citedLocation = [];
  if (isBlank(cited_location)) {
    if (locationRequired) missing.push("cited_location");
  } else if (typeof cited_location === "string" || Array.isArray(cited_location)) {
    const raw = (typeof cited_location === "string" ? cited_location.split(",") : cited_location)
      .map((x) => (typeof x === "string" ? x.trim() : x))
      .filter((x) => !(typeof x === "string" && x === ""));
    const good = [];
    let bad = false;
    for (const item of raw) {
      if (typeof item === "string" && CITED_LOCATION_RE.test(item)) good.push(item);
      else bad = true;
    }
    if (bad) invalid.push("cited_location");
    // When every anchor was malformed the field is both wrong and effectively
    // absent; "invalid" already says so, so don't also report it missing.
    if (good.length === 0 && locationRequired && !bad) missing.push("cited_location");
    citedLocation = good;
  } else {
    invalid.push("cited_location");
  }

  // ── sibling_scope (optional) ─────────────────────────────────────────────
  let siblingScope = null;
  if (!isBlank(sibling_scope)) {
    if (typeof sibling_scope !== "string") invalid.push("sibling_scope");
    else siblingScope = oneLine(sibling_scope).slice(0, MAX_SIBLING_SCOPE) || null;
  }

  // ── spawned_by_origin_id (required, F12 shape) ───────────────────────────
  const originKey = KIND_TO_ORIGIN_KEY[kind];
  const originCandidate = !isBlank(spawned_by_origin_id)
    ? spawned_by_origin_id
    : originKey
      ? spawnedBy[originKey]
      : undefined;
  if (isBlank(originCandidate)) missing.push("spawned_by_origin_id");
  else if (!isOriginIdShape(typeof originCandidate === "string" ? originCandidate.trim() : originCandidate)) {
    invalid.push("spawned_by_origin_id");
  }

  const contract = invariantText
    ? {
        version: CONTRACT_VERSION,
        invariant: invariantText,
        evidenceSource,
        evidenceRepro,
        citedLocation,
        siblingScope,
      }
    : null;

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, contract };
}

/**
 * Render a contract as the line-based block that ships in the ticket
 * description. Deliberately NOT YAML-library output: these Lambdas carry no
 * dependencies, the grammar is fixed, and a hand-rolled renderer/parser pair
 * that round-trips is smaller than the reasons to add a parser dependency.
 *
 * Multi-line fields use the `|` form with two-space-indented continuation
 * lines. Empty values are omitted entirely so the block never carries
 * "evidence_repro: null" for a reader to misinterpret as a literal.
 */
export function renderFixContractBlock(contract, meta = {}) {
  if (!contract || typeof contract !== "object") return "";
  const { kind, originId, phase } = meta;
  const lines = [OPEN_MARKER];

  const scalar = (key, value) => {
    if (isBlank(value)) return;
    lines.push(`${key}: ${oneLine(value)}`);
  };

  scalar("kind", kind);
  scalar("origin", originId);
  scalar("phase", phase);
  scalar("evidence_source", contract.evidenceSource);
  scalar("evidence_repro", contract.evidenceRepro);

  const locs = Array.isArray(contract.citedLocation) ? contract.citedLocation.filter((l) => !isBlank(l)) : [];
  if (locs.length > 0) {
    lines.push("cited_location:");
    for (const loc of locs) lines.push(`  - ${oneLine(loc)}`);
  }

  scalar("sibling_scope", contract.siblingScope);

  // invariant last and always in block form: it is the field a reader should end
  // on, and it is the only one that may legitimately span lines.
  if (!isBlank(contract.invariant)) {
    lines.push("invariant: |");
    for (const line of stripControl(contract.invariant).split("\n")) lines.push(`  ${line.trim()}`);
  }

  lines.push(CLOSE_MARKER);
  return lines.join("\n");
}

/**
 * Parse a rendered block back out of a ticket description. Returns
 * { contract, kind, originId, phase, rest } or null when `text` does not start
 * with a well-formed block (leading blank lines are tolerated; anything else
 * before the open marker means there is no block here).
 *
 * Tolerant by design: a missing key yields null rather than an error, because
 * this parser reads text that a human may have edited in the Jira UI and a
 * partially-mangled contract is still worth more than nothing.
 *
 * `rest` is everything after the close marker, trimmed — the ticket's actual
 * prose description.
 */
export function parseFixContractBlock(text) {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i] !== OPEN_MARKER) return null;
  i++;

  const scalars = {};
  const locs = [];
  let blockKey = null;
  let blockLines = [];
  let closeIdx = -1;

  const flushBlock = () => {
    if (blockKey) {
      scalars[blockKey] = blockLines.join("\n").trim();
      blockKey = null;
      blockLines = [];
    }
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === CLOSE_MARKER) {
      flushBlock();
      closeIdx = i;
      break;
    }
    // A scalar key line always ends an open `|` block (checked before the
    // continuation rule, so `invariant: |` followed by `kind: x` cannot swallow
    // the next key).
    const km = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (km) {
      flushBlock();
      const key = km[1];
      const value = km[2] === undefined ? "" : km[2];
      if (key === "cited_location") {
        // Inline comma form is accepted too, so a human-edited block still parses.
        for (const part of value.split(",")) if (part.trim()) locs.push(part.trim());
        continue;
      }
      if (value.trim() === "|") {
        blockKey = key;
        blockLines = [];
        continue;
      }
      scalars[key] = value.trim();
      continue;
    }
    if (blockKey) {
      if (line.trim() === "") blockLines.push("");
      else if (/^ {2}/.test(line)) blockLines.push(line.slice(2));
      else flushBlock(); // unindented prose — the block ended without a key line
      continue;
    }
    const lm = /^ {2}- (.+)$/.exec(line);
    if (lm) locs.push(lm[1].trim());
    // Anything else inside the block is ignored (tolerant parse).
  }

  flushBlock();
  if (closeIdx === -1) return null; // unterminated block — not a contract

  return {
    contract: {
      version: CONTRACT_VERSION,
      invariant: scalars.invariant || null,
      evidenceSource: scalars.evidence_source || null,
      evidenceRepro: scalars.evidence_repro || null,
      citedLocation: locs,
      siblingScope: scalars.sibling_scope || null,
    },
    kind: scalars.kind || null,
    originId: scalars.origin || null,
    phase: scalars.phase || null,
    rest: lines.slice(closeIdx + 1).join("\n").trim(),
  };
}

/**
 * The system labels a fix ticket carries. These are the machine-readable index
 * over the contract: `fix:` drives the completion gate, `origin:` the lineage,
 * `evidence:`/`phase:` the dashboards, and `contract:incomplete` marks a ticket
 * that SHADOW mode let through so it is findable later.
 */
export function contractLabels(contract, meta = {}) {
  const { kind, originId, phase, incomplete } = meta;
  const out = [];
  const push = (prefix, value) => {
    if (isBlank(value)) return;
    out.push(`${prefix}${oneLine(value)}`);
  };
  push("fix:", kind);
  push("origin:", originId);
  push("evidence:", contract && contract.evidenceSource);
  push("phase:", phase);
  if (incomplete) out.push("contract:incomplete");
  return out;
}

/**
 * Is `advisory` a forbidden label on THIS ticket? True for any fix ticket (a
 * sanitized spawned_by with a known kind) and any human-review gate. See
 * RESERVED_ADVISORY_LABEL for why.
 *
 * Takes the ALREADY-SANITIZED spawnedBy (sanitizeSpawnedBy's `value`) so a caller
 * cannot reserve/unreserve the word with a junk kind, but also accepts the raw
 * marker shape defensively — the only thing that matters is a known kind.
 */
export function advisoryIsReserved({ spawnedBy, assignee } = {}) {
  if (spawnedBy && typeof spawnedBy === "object" && FIX_KINDS.includes(spawnedBy.kind)) return true;
  return typeof assignee === "string" && assignee.startsWith("human:");
}

/**
 * Normalize caller-supplied labels and drop any that squat a system namespace.
 * Returns { labels, dropped } — `dropped` is reported back to the caller rather
 * than silently swallowed, so an agent learns its label was refused instead of
 * wondering why its filter finds nothing.
 *
 * The namespace check runs on the lowercased/trimmed input BEFORE character
 * substitution: normalization maps ":" → "-", so checking afterwards would let
 * "fix:qa_fix" through as "fix-qa_fix" and defeat the point.
 *
 * TEAM-4131 F2 — the optional second argument carries the ticket's SHAPE
 * ({ spawnedBy, assignee }). With it, `advisory` is additionally dropped on a fix
 * ticket or a human gate. Omitted (the ordinary backlog-ticket call), behaviour
 * is byte-identical to before: `advisory` is a perfectly good user label there.
 */
export function sanitizeUserLabels(labels, shape = {}) {
  const raw = labels === undefined || labels === null
    ? []
    : Array.isArray(labels)
      ? labels
      : typeof labels === "string"
        ? labels.split(",")
        : [labels];

  const out = [];
  const dropped = [];
  const seen = new Set();
  const noAdvisory = advisoryIsReserved(shape);

  for (const item of raw) {
    if (typeof item !== "string") {
      if (item !== undefined && item !== null) dropped.push(String(item));
      continue;
    }
    const lowered = item.trim().toLowerCase();
    if (lowered === "") continue;
    if (SYSTEM_LABEL_PREFIXES.some((p) => lowered.startsWith(p))) {
      dropped.push(lowered);
      continue;
    }
    // EXACT word only, like completion.mjs's reader: "advisory-ish" is a real
    // label and stays. Checked on the trimmed/lowercased input for the same
    // reason the namespace check is.
    if (noAdvisory && lowered === RESERVED_ADVISORY_LABEL) {
      dropped.push(lowered);
      continue;
    }
    const normalized = lowered.replace(/[^a-z0-9._-]/g, "-").slice(0, MAX_LABEL);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return { labels: out, dropped };
}

/**
 * Escape a value for interpolation inside a double-quoted JQL string literal
 * (F6). Backslash FIRST, then the quote — the other order would double-escape
 * the backslashes this function itself introduces, turning `a"b` into `a\\"b`
 * (an escaped backslash followed by an unescaped quote, which terminates the
 * literal and hands the rest of the string to Jira as JQL).
 */
export function escapeJql(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Normalize an agent-supplied `spawned_by` marker. Returns { value } for a clean
 * marker, { error } for a malformed one (unknown kind / not an object), or
 * { value: null, error: null } when absent (backward-compatible — no field
 * written). Only the known `kind`, origin-id keys, and allow-listed extras
 * survive; arbitrary extra keys are dropped so agents can't write junk onto the
 * ticket record, and origin ids that don't LOOK like ticket ids are dropped
 * rather than trusted (F12).
 */
export function sanitizeSpawnedBy(raw) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, error: "'spawned_by' must be an object like { kind: 'qa_fix', qaTicketId: 'TEAM-42' }" };
  }
  if (!FIX_KINDS.includes(raw.kind)) {
    return { value: null, error: `'spawned_by.kind' must be one of: ${FIX_KINDS.join(", ")}` };
  }
  const value = { kind: raw.kind };
  for (const k of SPAWN_ORIGIN_KEYS) {
    if (isOriginIdShape(raw[k])) value[k] = raw[k];
  }
  for (const k of SPAWN_EXTRA_KEYS) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (k === "reverify") {
      value.reverify = Boolean(raw.reverify);
      continue;
    }
    if (k === "round") {
      // Accept the string form too: agents fill this from a prompt, and "2" is
      // the shape a JSON-ish tool call most often produces.
      const n = Number(raw.round);
      if (Number.isFinite(n) && n >= 1 && n <= MAX_SPAWN_ROUND) value.round = Math.floor(n);
      continue;
    }
    if (typeof raw[k] === "string" && BARE_ID_RE.test(raw[k])) value[k] = raw[k];
  }
  return { value, error: null };
}
