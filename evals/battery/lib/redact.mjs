// Shared forbidden-pattern table + scan/redact helpers (C2 / F-5).
// Two consumers, one source of truth:
//   - lint-fixtures.mjs scans cases/, fixtures/, and the committed
//     baseline.json (repo content must be clean before it lands);
//   - run-battery.mjs redacts every generated artifact (battery-results.json,
//     check-summary.md, baseline.json) at write time, because check-summary.md
//     is published verbatim into a public check run and raw agent/judge error
//     strings can carry anything.
// No deps beyond node builtins.

import { writeFileSync } from "node:fs";

// GitHub owners that may legitimately appear in fixtures and generated docs.
export const GITHUB_OWNER_ALLOWLIST = ["example-org", "example", "actions", "github"];

// AWS secret access keys are 40 chars of [A-Za-z0-9/+] with non-charset
// boundaries. To avoid flagging legit 40-char tokens (git shas are lowercase
// hex), require at least one uppercase, one lowercase, and one digit inside
// the 40-char window — real keys are mixed-case base64 in practice, plain
// shas/base64 slugs of a single case are not.
const AWS_SECRET_KEY =
  /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;

// Any github.com/<owner> whose owner is NOT allowlisted — not just the one
// real owner the old rule named. Owner comparison is case-insensitive, and
// the allowlist lookahead requires the owner to END there (so example-org is
// not rejected by the shorter 'example' alternative, and 'examples' is not
// sneaked past by the 'example' prefix).
const GITHUB_OWNER = new RegExp(
  `github\\.com/(?!(?:${GITHUB_OWNER_ALLOWLIST.join("|")})(?![A-Za-z0-9-]))[A-Za-z0-9-]+`,
  "i"
);

export const FORBIDDEN = [
  [/TEAM-[0-9]+/i, "real Jira project key (use BATT-*)"],
  [/atlassian\.net/i, "real Jira host"],
  [GITHUB_OWNER, "non-allowlisted GitHub owner (use example-org/sample-service)"],
  [/agentcore-hub-artifacts/, "real artifact bucket name"],
  [/arn:aws/, "AWS ARN"],
  [/[0-9]{12}/, "AWS-account-shaped id (12 consecutive digits)"],
  [/wf_[0-9]{13}/, "prod workflow-id shape (use wf_battery_*)"],
  [/AKIA[A-Z0-9]{16}/, "AWS access key id"],
  [AWS_SECRET_KEY, "AWS-secret-shaped token (40-char mixed-case base64)"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "JWT"],
  [/xox[baprs]-[A-Za-z0-9][A-Za-z0-9-]*/, "Slack token"],
  [/hooks\.slack\.com/i, "Slack webhook URL"],
  [/discord(?:app)?\.com\/api\/webhooks/i, "Discord webhook URL"],
  [/-----BEGIN/, "PEM material"],
  [/x-api-key/i, "API key header"],
  [/Bearer [A-Za-z0-9]/, "bearer token"],
];

// URL-decoded copies of a line (plain decode + a plus-to-space variant), so
// %54EAM-3067 / atlassian%2Enet style encoding cannot dodge the patterns.
// Undecodable input (lone %) is not an error — the raw line is still scanned.
function decodedVariants(line) {
  const out = [];
  for (const candidate of [line, line.replace(/\+/g, " ")]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded !== line && !out.includes(decoded)) out.push(decoded);
    } catch {
      /* not valid percent-encoding — nothing extra to scan */
    }
  }
  return out;
}

/**
 * Scan text for forbidden patterns. Each line is matched raw AND URL-decoded;
 * a hit on a decoded copy reports the original line number. Returns
 * [{ file, line, pattern, why }] with at most one finding per (line, pattern).
 */
export function scanText(text, { file } = {}) {
  const findings = [];
  String(text)
    .split("\n")
    .forEach((raw, i) => {
      const variants = [raw, ...decodedVariants(raw)];
      for (const [pattern, why] of FORBIDDEN) {
        if (variants.some((v) => pattern.test(v)))
          findings.push({ file: file ?? null, line: i + 1, pattern: String(pattern), why });
      }
    });
  return findings;
}

/**
 * Replace every forbidden match with [REDACTED:<why>]. A line whose URL-
 * decoded copy still matches after in-place replacement (encoded payload)
 * is dropped wholesale — decoded matches cannot be mapped back precisely.
 * Returns { text, count, reasons } — reasons are pattern descriptions only,
 * never matched text, so they are safe to log.
 */
export function redactText(text) {
  let count = 0;
  const reasons = new Set();
  const lines = String(text)
    .split("\n")
    .map((raw) => {
      let line = raw;
      for (const [pattern, why] of FORBIDDEN) {
        const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        line = line.replace(global, () => {
          count++;
          reasons.add(why);
          return `[REDACTED:${why}]`;
        });
      }
      for (const variant of decodedVariants(line)) {
        for (const [pattern, why] of FORBIDDEN) {
          if (pattern.test(variant)) {
            count++;
            reasons.add(why);
            return `[REDACTED-LINE:${why} (url-encoded)]`;
          }
        }
      }
      return line;
    });
  return { text: lines.join("\n"), count, reasons: [...reasons] };
}

/**
 * The single write-time choke point for generated artifacts: redact, warn
 * (reasons only — never the matched text), then write.
 */
export function writeRedacted(path, content, { warn = console.warn } = {}) {
  const { text, count, reasons } = redactText(String(content));
  if (count > 0)
    warn(`warn: redacted ${count} forbidden match(es) before writing ${path} — ${reasons.join("; ")}`);
  writeFileSync(path, text);
  return { count, reasons };
}
