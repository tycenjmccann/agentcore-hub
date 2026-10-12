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
 * prose — and a hit whose own sentence says the step was DONE ("the manual step
 * was completed", "must be run by CI, and CI ran it") is not an admission, unless
 * that sentence also negates ("was not completed"). A hit is satisfied only when
 * EVERY script or deliverable the hit's window names is named by some follow-up's
 * title/detail (one ticketed script never covers a second one) (the hit sentence plus up to
 * WINDOW_BACK sentences before it — the command does not always sit in the
 * sentence right before the admission; TEAM-5593's own 17w716 replay against a
 * real completion record has it two sentences earlier, in its own clause: "the
 * pipeline lists lambda/cost-report/deploy.sh as a script a human must run.
 * Run `deploy.sh --backfill` ... I did NOT run it."). A window that names
 * nothing is satisfied by any follow-up at all.
 */

const WINDOW_BACK = 4;

export const MANUAL_STEP_PATTERNS = [
  /\ba human needs to\b/i,
  /\bmust be run by\b/i,
  /\bI did not run\b(?!\s+into\b)/i,
  /(?<!\b(?:no|without|zero|any|not a)\s+)\bmanual steps?\b/i,
  /\bdeferred to a follow[- ]up PRD\b/i,
  /\bnot run by me\b/i,
];

// Review F4: a sentence reporting the step as finished, and the negations that
// turn it back into an admission ("was NOT completed", "hasn't been done").
const COMPLETED_RE = /\b(?:completed|ran it|was run|were run|succeeded|done)\b/i;
const NEGATION_RE = /\bnot\b|n't\b|\bnever\b/i;

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

/** True when the sentence reports the step as finished, and does not negate it. */
export function statesCompletion(sentence) {
  return COMPLETED_RE.test(sentence) && !NEGATION_RE.test(sentence);
}

/**
 * → the tokens no follow-up names (empty = satisfied). Review F5: EVERY distinct
 * step must be ticketed — `a.sh` and `b.sh` in one window are two steps, and a
 * follow-up for `b.sh` says nothing about `a.sh`.
 */
function unticketedTokens(tokens, followUps) {
  const { paths, flags, spans } = tokens;
  // A named script is the identity of the step; a flag or span only stands in
  // when the window names no script.
  const needles = paths.length > 0 ? paths : [...new Set([...spans, ...flags])];
  if (needles.length === 0) return followUps.length > 0 ? [] : ["the manual step"];
  const texts = followUps.map((f) => `${f?.title ?? ""}\n${f?.detail ?? ""}`.toLowerCase());
  return needles.filter((n) => !texts.some((t) => t.includes(n.toLowerCase())));
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
  const misses = [];
  sentences.forEach((sentence, i) => {
    if (!MANUAL_STEP_PATTERNS.some((re) => re.test(sentence))) return;
    if (statesCompletion(sentence)) return;
    // Walk back one sentence at a time and stop as soon as one names a token —
    // minimal extension, not a blind N-sentence grab. Real text (TEAM-5593's
    // own 17w716 replay) puts the command two sentences back in its own clause
    // ("... a script a human must run. Run `deploy.sh --backfill` ... That
    // closes ... I did NOT run it."), so one sentence back is not always enough;
    // but grabbing a fixed window would also pull in an UNRELATED earlier
    // command that has nothing to do with THIS admission. Only extend while the
    // sentences seen so far name nothing.
    let back = 1;
    let window = [sentences[i - 1], sentence].filter(Boolean).join(" ");
    let tokens = windowTokens(window);
    while (tokens.paths.length === 0 && tokens.flags.length === 0 && tokens.spans.length === 0 && back < WINDOW_BACK && i - back - 1 >= 0) {
      back += 1;
      window = [sentences[i - back], ...sentences.slice(i - back + 1, i), sentence].join(" ");
      tokens = windowTokens(window);
    }
    const missing = unticketedTokens(tokens, items);
    if (missing.length > 0) misses.push({ sentence, window, tokens, missing });
  });
  if (misses.length === 0) return null;
  const [first] = misses;
  const { paths, flags, spans } = first.tokens;
  // Name the step that is actually unticketed — the span that carries it when there is one.
  const gap = first.missing[0];
  const step = paths.length > 0
    ? spans.find((sp) => sp.toLowerCase().includes(gap.toLowerCase())) || gap
    : spans[0] || flags.join(" ") || gap;
  const expected = {
    kind: "console_handoff",
    owner: "human",
    assignee: "human:engineer",
    title: `Run ${clip(step)}`,
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
      `but no follow_ups entry names ${paths.length > 0 ? first.missing.map((m) => `\`${m}\``).join(", ") : "that step"}. Nothing was written. ` +
      `Call again with the same arguments plus a follow_ups entry of this shape: ${JSON.stringify(expected)}`,
  };
}
