/**
 * Writing-standard lint for registered deliverables (blueprints/writing-standard.md).
 *
 * Pure: no AWS, no I/O. The Lambda loads config/workflows.json, builds an index
 * with buildDeliverableIndex(), and asks lintDeliverable() before every markdown
 * write under workflows/<id>/shared/. A refusal is returned to the agent as a
 * value (which sections are missing, which template to load), never thrown.
 *
 * Only defs with `writingStandard: true` feed the index, and only entries that
 * name a family template (JSON packages, binaries, PRs and own-contract docs
 * such as plan.md have `template: null` or a non-markdown key and are skipped).
 * A deliverable name that appears in several defs must map to ONE family; the
 * config test in src/lib/workflow/deliverables.test.ts pins that.
 */

export const LEAD_MAX_WORDS = 80;

const H2 = /^## (.+?)\s*$/;
const HEADING = /^#{1,6} (.+?)\s*$/;
const LIST_OR_TABLE = /^(\s*[-*+]\s|\s*\d+[.)]\s|\s*\||\s*#)/;
// The pre-standard house style: a bare ALL-CAPS label line standing in for a heading.
const CAPS_LABEL = /^[A-Z][A-Z0-9'’/&(),-]*(?:\s+[A-Z0-9'’/&(),-]+){1,}\s*:?\s*$/;

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${esc}$`);
}

/** filename (after shared/) → { family, template, sections, defIds } */
export function buildDeliverableIndex(config) {
  const families = config?.deliverableFamilies || {};
  const exact = new Map();
  const patterns = [];
  for (const def of config?.workflows || []) {
    if (!def.writingStandard) continue;
    for (const e of def.deliverables || []) {
      const fam = families[e.family];
      if (!fam) continue;
      // `template` absent → the family's template applies; `null` → the doc has
      // its own contract (playbook plan.md, operator plan.md); any other value
      // (e.g. "review-package") is a different, non-markdown contract.
      const template = e.template === undefined ? fam.template : e.template;
      if (template !== fam.template) continue;
      if (e.kind === "pr" || e.kind === "binary" || !/\.md$/.test(e.key)) continue;
      const entry = { key: e.key, family: e.family, template, sections: fam.sections, defIds: [def.id] };
      if (e.key.includes("*")) {
        const prior = patterns.find((p) => p.key === e.key);
        if (prior) prior.defIds.push(def.id); else patterns.push({ ...entry, re: globToRegExp(e.key) });
      } else {
        const prior = exact.get(e.key);
        if (prior) prior.defIds.push(def.id); else exact.set(e.key, entry);
      }
    }
  }
  return { families, exact, patterns };
}

/** The shared/-relative name of a workspace key, or null when it is not one. */
export function sharedName(key) {
  const m = /^workflows\/[^/]+\/shared\/(.+)$/.exec(String(key || ""));
  return m ? m[1] : null;
}

export function matchDeliverable(index, key) {
  if (!index) return null;
  const name = sharedName(key);
  if (!name) return null;
  if (index.exact.has(name)) return index.exact.get(name);
  return index.patterns.find((p) => p.re.test(name)) || null;
}

/** Family descriptor by name (for save_design_doc, which is always `spec`). */
export function familyOf(index, family) {
  const fam = index?.families?.[family];
  return fam ? { family, template: fam.template, sections: fam.sections } : null;
}

function isCapsLabel(line) {
  const t = line.trim();
  if (!CAPS_LABEL.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 6 && letters === letters.toUpperCase();
}

/**
 * Structural checks only. Returns [] when the document conforms.
 *   1. `# Title` is the first non-blank line
 *   2. the family's `##` sections exist, in order, exact text, and the first
 *      `##` in the document is the family's first section
 *   3. extra `##` sections come after the last required one (appendix)
 *   4. the lead section (under the first heading) is prose: <= LEAD_MAX_WORDS
 *      words, no list, table or sub-heading
 *   5. no ALL-CAPS heading or bare ALL-CAPS label line, no `•` bullets
 */
export function lintMarkdown(content, sections) {
  const problems = [];
  const text = String(content || "");
  const lines = text.split(/\r?\n/);

  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx < 0) return ["document is empty"];
  if (!/^# \S/.test(lines[firstIdx])) problems.push("first line must be the document title as `# Title`");

  const h2s = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = H2.exec(l);
    if (m) h2s.push({ name: m[1].trim(), line: i });
  });
  const names = h2s.map((h) => h.name);

  const required = sections || [];
  let cursor = -1;
  let orderBroken = false;
  for (const s of required) {
    const idx = names.indexOf(s);
    if (idx < 0) { problems.push(`missing section \`## ${s}\``); continue; }
    if (idx < cursor) orderBroken = true;
    cursor = Math.max(cursor, idx);
  }
  if (orderBroken) problems.push(`sections out of order; required order is ${required.map((s) => `\`## ${s}\``).join(", ")}`);
  if (required.length && names.length && names[0] !== required[0]) {
    problems.push(`the first \`##\` section must be \`## ${required[0]}\` (found \`## ${names[0]}\`); the answer comes first`);
  }
  const lastReqIdx = Math.max(-1, ...required.map((s) => names.indexOf(s)));
  const extrasBefore = names.filter((n, i) => !required.includes(n) && i < lastReqIdx);
  if (extrasBefore.length) problems.push(`extra sections must follow the template's sections, not sit between them: ${extrasBefore.map((n) => `\`## ${n}\``).join(", ")}`);

  // Lead: the body of the first required section.
  if (required.length && names[0] === required[0]) {
    const start = h2s[0].line + 1;
    const end = h2s[1] ? h2s[1].line : lines.length;
    const body = lines.slice(start, end);
    let fence = false;
    const prose = [];
    for (const l of body) {
      if (/^\s*```/.test(l)) { fence = !fence; continue; }
      if (fence) continue;
      if (l.trim() === "") continue;
      if (LIST_OR_TABLE.test(l)) { problems.push(`\`## ${required[0]}\` must be prose: no list, table or sub-heading in the lead`); break; }
      prose.push(l);
    }
    const words = prose.join(" ").split(/\s+/).filter(Boolean).length;
    if (words === 0) problems.push(`\`## ${required[0]}\` is empty; state the conclusion in one to three sentences`);
    else if (words > LEAD_MAX_WORDS) problems.push(`\`## ${required[0]}\` is ${words} words; the lead is one to three sentences (max ${LEAD_MAX_WORDS} words)`);
  }

  inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const hm = HEADING.exec(l);
    if (hm) {
      const letters = hm[1].replace(/[^A-Za-z]/g, "");
      if (letters.length >= 4 && letters === letters.toUpperCase()) { problems.push(`ALL-CAPS heading \`${hm[1].trim()}\`; use sentence case`); }
    } else if (isCapsLabel(l)) {
      problems.push(`bare ALL-CAPS label \`${l.trim()}\`; make it a \`##\` section or a sentence`);
    }
    if (l.includes("•")) { problems.push("`•` bullets do not render; use `-`"); break; }
  }
  return [...new Set(problems)];
}

/**
 * The tool-facing check. `match` comes from matchDeliverable()/familyOf().
 * Returns null when the document conforms, else the refusal payload.
 */
export function lintDeliverable({ key, content, match }) {
  if (!match) return null;
  const problems = lintMarkdown(content, match.sections);
  if (!problems.length) return null;
  return {
    status: "refused",
    reason: "writing_standard",
    key,
    family: match.family,
    template: match.template,
    problems,
    message: `Not written: ${sharedName(key) || key} is a registered ${match.family} deliverable and must follow load_blueprint("${match.template}") (sections ${match.sections.map((s) => `## ${s}`).join(" / ")}, answer first). Fix the ${problems.length} problem(s) listed and write again. Do not rename the file to skip this check.`,
  };
}
