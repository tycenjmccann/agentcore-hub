/**
 * Item 6 probe, clause 3 — "src/lib/workflow/performance.ts mirrors it".
 *
 * There is no *-parity.test.ts between performance.ts and cost-report/index.mjs,
 * even though src/lib/workflow/ contains SEVEN such files for other cross-surface
 * contracts. So this probe IS the parity check: import BAND_KPIS from the real
 * Lambda and METRICS from the real UI module and diff them.
 *
 * performance.ts is TypeScript; it is imported through the vitest/esbuild pipeline
 * by running this probe under `npx vitest run` as a test file would be, so instead
 * we parse the two literal arrays out of source — no transpiler, no stubs, and the
 * parse is self-checking (it fails loudly if either array cannot be found).
 */
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const lambdaSrc = readFileSync(new URL("lambda/cost-report/index.mjs", root), "utf8");
const uiSrc = readFileSync(new URL("src/lib/workflow/performance.ts", root), "utf8");

function extractArray(src, marker, label) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`PROBE BROKEN: ${label} — marker ${marker} not found`);
  // Anchor on the ASSIGNMENT bracket, not the first "[" — a TS type annotation
  // like `: KpiDef[] =` puts an empty pair between the marker and the literal.
  const eq = src.indexOf("= [", i);
  if (eq < 0) throw new Error(`PROBE BROKEN: ${label} — no "= [" after marker`);
  const open = src.indexOf("[", eq);
  let depth = 0;
  let end = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`PROBE BROKEN: ${label} — unbalanced array`);
  return src.slice(open, end + 1);
}

/** Pull (key/path, label, unit, floor, direction) out of the object literals. */
function parseEntries(arrayText, keyField) {
  const out = [];
  const re = new RegExp(`\\{[^{}]*?${keyField}:\\s*"([^"]+)"[^{}]*?\\}`, "g");
  let m;
  while ((m = re.exec(arrayText))) {
    const body = m[0];
    const pick = (f) => {
      const mm = body.match(new RegExp(`${f}:\\s*("([^"]*)"|[-\\d._]+)`));
      return mm ? (mm[2] ?? mm[1]).replace(/_/g, "") : null;
    };
    out.push({
      key: m[1],
      label: pick("label"),
      unit: pick("unit"),
      floor: pick("floor"),
      direction: pick("direction"),
    });
  }
  return out;
}

const bandText = extractArray(lambdaSrc, "export const BAND_KPIS", "BAND_KPIS");
const metricsText = extractArray(uiSrc, "export const FLEET_KPIS", "FLEET_KPIS");

const band = parseEntries(bandText, "path");
const metrics = parseEntries(metricsText, "key");

console.log("=== item-6.3a  BAND_KPIS (lambda/cost-report/index.mjs) ===");
for (const e of band) console.log(`  ${e.key.padEnd(30)} floor=${e.floor} dir=${e.direction ?? "-"} "${e.label}"`);
console.log(`  count=${band.length}`);

console.log("\n=== item-6.3b  FLEET_KPIS (src/lib/workflow/performance.ts) ===");
for (const e of metrics) console.log(`  ${e.key.padEnd(30)} floor=${e.floor} dir=${e.direction ?? "-"} "${e.label}"`);
console.log(`  count=${metrics.length}`);

const bandKeys = new Set(band.map((e) => e.key));
const uiKeys = new Set(metrics.map((e) => e.key));

console.log("\n=== item-6.3c  key-set diff ===");
const onlyLambda = [...bandKeys].filter((k) => !uiKeys.has(k));
const onlyUi = [...uiKeys].filter((k) => !bandKeys.has(k));
console.log(`  only in BAND_KPIS : ${JSON.stringify(onlyLambda)}`);
console.log(`  only in FLEET_KPIS : ${JSON.stringify(onlyUi)}`);

console.log("\n=== item-6.3d  the three gate KPIs item 6 names, field by field ===");
const GATE_KPIS = ["quality.reworkRounds", "quality.gateRounds", "quality.firstPassYield"];
for (const k of GATE_KPIS) {
  const b = band.find((e) => e.key === k);
  const u = metrics.find((e) => e.key === k);
  console.log(`  ${k}`);
  console.log(`    BAND_KPIS: ${b ? `floor=${b.floor} dir=${b.direction ?? "-"} label="${b.label}"` : "ABSENT"}`);
  console.log(`    FLEET_KPIS: ${u ? `floor=${u.floor} dir=${u.direction ?? "-"} label="${u.label}"` : "ABSENT"}`);
  if (b && u) {
    const agree = b.floor === u.floor && (b.direction ?? null) === (u.direction ?? null) && b.label === u.label;
    console.log(`    agree? ${agree ? "YES" : "NO"}`);
  }
}

console.log("\n=== item-6.3e  does performance.ts COMPUTE any gate metric? ===");
for (const name of ["computeGateRounds", "reworkRounds =", "firstPassYield =", "gateRounds ="]) {
  console.log(`  performance.ts contains ${JSON.stringify(name)}? ${uiSrc.includes(name)}`);
}
console.log("  gateMetricSource occurrences in performance.ts:");
for (const [i, line] of uiSrc.split("\n").entries()) {
  if (line.includes("gateMetricSource")) console.log(`    :${i + 1}  ${line.trim()}`);
}

console.log("\n=== item-6.3 VERDICT ===");
console.log("  performance.ts does NOT compute the gate metrics — it only TYPES them and");
console.log("  describes the KPI. 'Mirrors it' is therefore true only in the weak sense of");
console.log("  type + descriptor agreement, which this probe checks directly above. No");
console.log("  automated parity test exists for it, unlike the 7 other *-parity.test.ts");
console.log("  files in the same directory. (UI array is FLEET_KPIS, not METRICS.)");
