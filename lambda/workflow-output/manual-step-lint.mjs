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
 * prose. A hit is satisfied by any follow-up whose title/detail names the same
 * script or deliverable the hit's window names (the hit sentence plus the one
 * before it — the command usually precedes the admission). A window that names
 * nothing is satisfied by any follow-up at all.
 */

export const MANUAL_STEP_PATTERNS = [
  /\ba human needs to\b/i,
  /\bmust be run by\b/i,
  /\bI did not run\b(?!\s+into\b)/i,
  /(?<!\b(?:no|without|zero|any|not a)\s+)\bmanual steps?\b/i,
  /\bdeferred to a follow[- ]up PRD\b/i,
  /\bnot run by me\b/i,
];

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

function satisfiedBy(tokens, followUps) {
  if (followUps.length === 0) return false;
  const { paths, flags, spans } = tokens;
  if (paths.length === 0 && flags.length === 0 && spans.length === 0) return true;
  const texts = followUps.map((f) => `${f?.title ?? ""}\n${f?.detail ?? ""}`.toLowerCase());
  // A named script is the identity of the step; a flag or span only stands in
  // when the window names no script.
  const needles = paths.length > 0 ? paths : [...flags, ...spans];
  return needles.some((n) => texts.some((t) => t.includes(n.toLowerCase())));
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
    const window = i > 0 ? `${sentences[i - 1]} ${sentence}` : sentence;
    const tokens = windowTokens(window);
    if (!satisfiedBy(tokens, items)) misses.push({ sentence, window, tokens });
  });
  if (misses.length === 0) return null;
  const [first] = misses;
  const { paths, flags, spans } = first.tokens;
  const step = spans[0] || [paths[0], ...flags].filter(Boolean).join(" ") || "the manual step";
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
      `but no follow_ups entry names ${paths[0] ? `\`${paths[0]}\`` : "that step"}. Nothing was written. ` +
      `Call again with the same arguments plus a follow_ups entry of this shape: ${JSON.stringify(expected)}`,
  };
}
