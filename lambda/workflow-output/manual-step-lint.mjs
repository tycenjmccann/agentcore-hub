/**
 * Unticketed-manual-step lint for report_completion (TEAM-5593).
 *
 * Pure: no AWS, no I/O. A completion summary that admits a step was left for
 * someone else ("I did NOT run it", "a human needs to …") but files no
 * follow-up for it is the shape that lost work in run 17w716: the ticket went
 * Done and the step existed only in prose. reportCompletion asks
 * lintManualSteps() before any write; a refusal is returned to the agent as a
 * value (the sentence, the follow-up shape that would satisfy it), never thrown.
 *
 * Fixed phrases only — a bare "not run" would trip on "CI ran the tests" style
 * prose. Review R2 F4: four phrases are INHERENTLY unfinished ("a human needs
 * to", "I did NOT run", "not run by me", "deferred to a follow-up PRD") and are
 * never excused. The two QUALIFIED ones ("manual step", "must be run by") are
 * excused only when their OWN clause (split on ; , and/but) reports the step
 * done in the past tense with no negation and no future/need marker — a
 * completion word elsewhere in the sentence ("…; the pipeline succeeded",
 * "this will be done after the release") excuses nothing.
 *
 * Review R2 F5: only RUNNABLE tokens are steps — a script invoked by a run
 * verb, anything carrying --flags, anything right after run/execute/invoke, an
 * interpreter command line. An edited file named in passing (`src/app.ts`) is
 * not a step. Steps come from the hit's own clause first, then the rest of its
 * sentence, then up to WINDOW_BACK earlier sentences (anaphora: "I did NOT run
 * it."); the walk stops at the first place that names a step, so an unrelated
 * earlier command is never pulled in. Every distinct step needs some follow-up
 * naming it (one ticketed script never covers a second one); a hit that names
 * no step is satisfied by any follow-up at all.
 */

const WINDOW_BACK = 4;

const INHERENT_PATTERNS = [
  /\ba human needs to\b/gi,
  /\bI did not run\b(?!\s+into\b)/gi,
  /\bdeferred to a follow[- ]up PRD\b/gi,
  /\bnot run by me\b/gi,
];
const QUALIFIED_PATTERNS = [
  /\bmust be run by\b/gi,
  /(?<!\b(?:no|without|zero|any|not a)\s+)\bmanual steps?\b/gi,
];

// A clause reporting its step finished, and what turns it back into an
// admission: a negation ("was NOT completed") or a future/need marker ("will be
// done after the release").
const PAST_DONE_RE = /\b(?:completed|finished|done|succeeded|ran|executed|(?:was|were|been) run)\b/i;
const NEGATION_RE = /\bnot\b|n't\b|\bnever\b/i;
const PENDING_RE = /\b(?:will|needs? to|after|later|pending|todo|to-do|yet to|still)\b/i;
const CLAUSE_SEP_RE = /\s*[;,]\s*(?:(?:and|but)\s+)?|\s+(?:and|but)\s+/gi;

// Runnable-token signals.
const RUN_VERB_RE = /\b(?:re-?run|run|execute|invoke)\b/gi;
const AFTER_VERB_RE = /\b(?:re-?run|run|execute|invoke)\s+(?:the\s+)?(?:script\s+)?$/i;
const PASSIVE_AFTER_RE = /^`?\s*(?:(?:must|should|needs? to|has to|have to|is to|to)\s+)?(?:be\s+)?(?:re-?run|run|executed|invoked)\b/i;
const RUNNABLE_EXT_RE = /\.(?:sh|py|mjs|cjs|js|ts)$/i;
const INTERPRETER_RE = /^(?:\.\/|(?:npm|npx|pnpm|yarn|node|python3?|bash|sh|make|aws|terraform|cdk)\s)/i;
const HAS_FLAG_RE = /(?<![\w-])--[a-z][\w-]*/i;
const TRAILING_FLAGS_RE = /^(?:\s+--[a-z][\w-]*)+/i;
// Another action between a run verb and a script means the verb is not
// running it ("run `deploy.sh` after updating `src/app.ts`").
const INTERRUPT_RE = /\b(?!(?:during|nothing|something|anything|string|pending|existing|need|seed|speed|feed)\b)(?:\w+(?:ed|ing)|updates?|edits?|changes?|modify|adds?|create|write|fix|refactor|touch|delete|remove|rename|move|commit|merge|review|read|open)\b/i;

const SENTENCE_MAX = 300;
const PATH_RE = /(?:[\w.-]*\/[\w./-]*[\w-]|[\w-]+\.(?:sh|mjs|cjs|js|ts|tsx|py|md|json|ya?ml|tf))(?![\w/])/g;
const FLAG_RE = /(?<![\w-])--[a-z][\w-]*/gi;
const BACKTICK_RE = /`([^`\n]{1,200})`/g;

/** Split prose into sentences; newlines and "…" end a sentence too. */
export function splitSentences(text) {
  return String(text || "")
    .split(/\n+|(?<=[.!?…])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function basename(p) {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}

/** Script/deliverable names, flags and backtick spans a window names. */
export function windowTokens(text) {
  const s = String(text || "");
  const paths = [...new Set([...s.matchAll(PATH_RE)].map((m) => basename(m[0])).filter((b) => b.length >= 3))];
  const flags = [...new Set([...s.matchAll(FLAG_RE)].map((m) => m[0]))];
  const spans = [...new Set([...s.matchAll(BACKTICK_RE)].map((m) => m[1].trim()).filter(Boolean))];
  return { paths, flags, spans };
}

/** Blank out backtick spans (same length) so separators inside them are ignored. */
function maskSpans(s) {
  return s.replace(BACKTICK_RE, (m) => `\`${"_".repeat(m.length - 2)}\``);
}

/** → [{start, end, text}] clauses of a sentence, split on ; , and/but outside backticks. */
export function splitClauses(sentence) {
  const masked = maskSpans(sentence);
  const out = [];
  let from = 0;
  for (const m of masked.matchAll(CLAUSE_SEP_RE)) {
    if (m[0].length === 0) continue;
    out.push({ start: from, end: m.index, text: sentence.slice(from, m.index) });
    from = m.index + m[0].length;
  }
  out.push({ start: from, end: sentence.length, text: sentence.slice(from) });
  return out.filter((c) => c.text.trim());
}

/** True when the clause reports its step done: past tense, no negation, no future/need marker. */
export function clauseStatesCompletion(clause) {
  const t = maskSpans(String(clause || ""));
  return PAST_DONE_RE.test(t) && !NEGATION_RE.test(t) && !PENDING_RE.test(t);
}

/** → the offset of the sentence's first unexcused admission, or -1. */
function admissionAt(sentence) {
  const clauses = splitClauses(sentence);
  const clauseAt = (i) => clauses.find((c) => i >= c.start && i < c.end) || { text: sentence };
  const offsets = [];
  for (const re of INHERENT_PATTERNS) for (const m of sentence.matchAll(re)) offsets.push(m.index);
  for (const re of QUALIFIED_PATTERNS) {
    for (const m of sentence.matchAll(re)) if (!clauseStatesCompletion(clauseAt(m.index).text)) offsets.push(m.index);
  }
  return offsets.length > 0 ? Math.min(...offsets) : -1;
}

/** A run verb earlier in the sentence governs the token: no other action in between. */
function governedByRunVerb(masked, start) {
  const verbs = [...masked.slice(0, start).matchAll(RUN_VERB_RE)];
  if (verbs.length === 0) return false;
  const last = verbs[verbs.length - 1];
  return !INTERRUPT_RE.test(masked.slice(last.index + last[0].length, start));
}

// Only a list connector between two tokens: "`a.sh` and then `b.sh`", "a.sh, b.sh".
const LIST_GAP_RE = /^\s*(?:(?:,|and|then|or|&&|plus)\s*)*$/i;
const listed = (s, a, b) => LIST_GAP_RE.test(s.slice(a.end, b.start));

/**
 * → [{needle, label, start, end}] the RUNNABLE steps a sentence names, in order.
 * needle = what a follow-up must mention (the script basename, else the span);
 * label = how the expected follow-up's title names it. A script listed next to
 * a runnable one ("run `a.sh` and `b.sh --prod`") is runnable too.
 */
export function runnableSteps(sentence) {
  const s = String(sentence || "");
  const masked = maskSpans(s);
  const found = [];
  const viaVerb = (start, end, path) =>
    AFTER_VERB_RE.test(s.slice(0, start)) ||
    (Boolean(path) && RUNNABLE_EXT_RE.test(path) && (governedByRunVerb(masked, start) || PASSIVE_AFTER_RE.test(s.slice(end))));
  for (const m of s.matchAll(BACKTICK_RE)) {
    const text = m[1].trim();
    if (!text) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    const path = [...text.matchAll(PATH_RE)][0]?.[0];
    const runnable = HAS_FLAG_RE.test(text) || INTERPRETER_RE.test(text) || viaVerb(start, end, path);
    found.push({ needle: path ? basename(path) : text, label: text, start, end, runnable, script: Boolean(path && RUNNABLE_EXT_RE.test(path)) });
  }
  for (const m of masked.matchAll(PATH_RE)) {
    const path = m[0];
    const start = m.index;
    if (basename(path).length < 3) continue;
    const flags = (s.slice(start + path.length).match(TRAILING_FLAGS_RE) || [""])[0];
    const end = start + path.length + flags.length;
    const runnable = Boolean(flags) || viaVerb(start, start + path.length, path);
    found.push({ needle: basename(path), label: `${path}${flags}`, start, end, runnable, script: RUNNABLE_EXT_RE.test(path) });
  }
  found.sort((a, b) => a.start - b.start);
  for (let changed = true; changed;) {
    changed = false;
    found.forEach((t, k) => {
      if (t.runnable || !t.script) return;
      const prev = found[k - 1];
      const next = found[k + 1];
      if ((prev?.runnable && listed(s, prev, t)) || (next?.runnable && listed(s, t, next))) {
        t.runnable = true;
        changed = true;
      }
    });
  }
  const seen = new Set();
  return found
    .filter((t) => t.runnable && !seen.has(t.needle.toLowerCase()) && seen.add(t.needle.toLowerCase()))
    .map(({ needle, label, start, end }) => ({ needle, label, start, end }));
}

/**
 * → { steps, window } for the hit at `offset` in sentences[i]: the hit clause
 * (plus any step listed next to one of its steps across an "and"), then the
 * rest of that sentence (earlier clauses first, nearest first), then earlier
 * sentences one at a time — stopping at the first that names a step.
 */
function stepsForHit(sentences, i, offset) {
  const sentence = sentences[i];
  const all = runnableSteps(sentence);
  const clauses = splitClauses(sentence);
  const hc = Math.max(0, clauses.findIndex((c) => offset >= c.start && offset < c.end));
  const order = [hc];
  for (let d = 1; d < clauses.length; d++) {
    if (hc - d >= 0) order.push(hc - d);
  }
  for (let d = 1; d < clauses.length; d++) {
    if (hc + d < clauses.length) order.push(hc + d);
  }
  for (const ci of order) {
    const { start, end } = clauses[ci];
    const idx = all.map((st, k) => (st.start >= start && st.start < end ? k : -1)).filter((k) => k >= 0);
    if (idx.length === 0) continue;
    let lo = idx[0];
    let hi = idx[idx.length - 1];
    while (lo > 0 && listed(sentence, all[lo - 1], all[lo])) lo -= 1;
    while (hi < all.length - 1 && listed(sentence, all[hi], all[hi + 1])) hi += 1;
    return { steps: all.slice(lo, hi + 1), window: sentence };
  }
  for (let back = 1; back <= WINDOW_BACK && i - back >= 0; back++) {
    const steps = runnableSteps(sentences[i - back]);
    if (steps.length > 0) return { steps, window: sentences.slice(i - back, i + 1).join(" ") };
  }
  return { steps: [], window: [sentences[i - 1], sentence].filter(Boolean).join(" ") };
}

function clip(s) {
  return s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX - 1)}…` : s;
}

/**
 * → null when every admitted manual step has a follow-up, else the refusal:
 * { ok:false, status:422, reason:"unticketed_manual_step", sentence,
 *   unticketed:[sentence…], expected:{kind,owner,assignee,title,detail}, message }
 */
export function lintManualSteps({ summary, followUps = [] } = {}) {
  const sentences = splitSentences(summary);
  const items = (Array.isArray(followUps) ? followUps : []).filter((f) => f && typeof f === "object");
  const texts = items.map((f) => `${f?.title ?? ""}\n${f?.detail ?? ""}`.toLowerCase());
  const misses = [];
  sentences.forEach((sentence, i) => {
    const offset = admissionAt(sentence);
    if (offset < 0) return;
    const { steps, window } = stepsForHit(sentences, i, offset);
    // Review F5: EVERY distinct step must be ticketed — `a.sh` and `b.sh` are
    // two steps, and a follow-up for `b.sh` says nothing about `a.sh`.
    const missing = steps.length > 0
      ? steps.filter((st) => !texts.some((t) => t.includes(st.needle.toLowerCase())))
      : items.length > 0 ? [] : [null];
    if (missing.length > 0) misses.push({ sentence, window, missing });
  });
  if (misses.length === 0) return null;
  const [first] = misses;
  const named = first.missing.filter(Boolean);
  const expected = {
    kind: "console_handoff",
    owner: "human",
    assignee: "human:engineer",
    title: `Run ${clip(named[0]?.label || "the manual step")}`,
    detail: clip(first.window),
  };
  return {
    ok: false,
    status: 422,
    reason: "unticketed_manual_step",
    sentence: clip(first.sentence),
    unticketed: misses.map((m) => clip(m.sentence)),
    expected,
    message:
      `report_completion refused (422 unticketed_manual_step): the summary says "${clip(first.sentence)}" ` +
      `but no follow_ups entry names ${named.length > 0 ? named.map((m) => `\`${m.needle}\``).join(", ") : "that step"}. Nothing was written. ` +
      `Call again with the same arguments plus a follow_ups entry of this shape: ${JSON.stringify(expected)}`,
  };
}
