// Pure result assembly + check-run markdown (design §2.5). The CI publisher
// job posts renderCheckSummary() output without executing PR code, so this is
// the only surface the gate exposes to reviewers.

const round2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);

export function buildResults({
  runId,
  configSha,
  baselineSha,
  scoringBackend,
  suite,
  caseResults,
  retiredCases,
  costEstimateUsd,
  runtimeSeconds,
}) {
  return {
    runId,
    configSha,
    baselineSha,
    scoringBackend,
    verdict: suite.verdict,
    failureReasons: suite.failureReasons,
    cases: caseResults.map((c) => ({
      id: c.id,
      status: c.status,
      attempt: c.attempt ?? null,
      modelTier: c.modelTier,
      sessionId: c.sessionId ?? null,
      toolTrajectory: (c.trajectory || []).map((t) => ({ tool: t.tool, argsDigest: t.argsDigest })),
      scores: c.scores || {},
      scoreDetails: c.details || {},
      deltas: suite.deltaRows.filter((r) => r.case === c.id),
      forbiddenHits: c.forbiddenHits || [],
      error: c.error ?? null,
      informational: suite.informationalCases.includes(c.id),
    })),
    summary: suite.summary,
    informationalCases: suite.informationalCases,
    retiredCases,
    costEstimateUsd: round2(costEstimateUsd),
    runtimeSeconds: round2(runtimeSeconds),
  };
}

export function renderCheckSummary(results) {
  const lines = [];
  const icon = results.verdict === "PASS" ? "✅" : "❌";
  lines.push(`# Config-evals battery: ${icon} ${results.verdict}`);
  lines.push("");
  lines.push(`- **Run:** \`${results.runId}\` @ \`${results.configSha}\``);
  lines.push(`- **Baseline:** \`${results.baselineSha}\` (backend: ${results.scoringBackend})`);
  lines.push(`- **Cost:** $${results.costEstimateUsd} — **Runtime:** ${results.runtimeSeconds}s`);
  const s = results.summary;
  if (s.overallBaseline !== null && s.overallBaseline !== undefined) {
    lines.push(`- **Overall:** baseline ${s.overallBaseline} → current ${s.overallCurrent} (Δ ${s.overallDelta}, scale ${s.scale})`);
  }
  lines.push("");

  if (results.failureReasons.length > 0) {
    lines.push("## Failure reasons");
    for (const reason of results.failureReasons) lines.push(`- ${reason}`);
    lines.push("");
  }

  const gatedRows = results.cases.flatMap((c) => c.deltas).filter((r) => r.verdict !== "informational");
  if (gatedRows.length > 0) {
    lines.push("## Per-evaluator deltas");
    lines.push("| Case | Evaluator | Baseline | Current | Δ | Floor | Verdict |");
    lines.push("|---|---|---:|---:|---:|---:|---|");
    for (const r of gatedRows) {
      const mark = r.verdict === "floor_breach" ? "❌ floor_breach" : "✅ pass";
      lines.push(`| ${r.case} | ${r.evaluator} | ${r.baseline} | ${r.current} | ${r.delta} | ${r.floor} | ${mark} |`);
    }
    lines.push("");
  }

  const floorBreaches = gatedRows.filter((r) => r.verdict === "floor_breach");
  if (floorBreaches.length > 0) {
    lines.push("## Floor violations");
    for (const r of floorBreaches)
      lines.push(`- **${r.case}** / **${r.evaluator}**: ${r.current} < floor ${r.floor}`);
    lines.push("");
  }

  const informational = results.cases.filter((c) => c.informational);
  if (informational.length > 0) {
    lines.push("## Informational (new cases — scores reported, no delta verdict)");
    for (const c of informational) {
      const scores = Object.entries(c.scores)
        .map(([e, v]) => `${e}=${v}`)
        .join(", ");
      lines.push(`- **${c.id}** (${c.status}): ${scores || "no scores"}`);
    }
    lines.push("");
  }

  const broken = results.cases.filter((c) => c.status !== "scored" && !c.informational);
  if (broken.length > 0) {
    lines.push("## Non-scored cases");
    for (const c of broken) lines.push(`- **${c.id}**: ${c.status}${c.error ? ` — ${c.error}` : ""}`);
    lines.push("");
  }

  if (results.retiredCases.length > 0) {
    lines.push("## Retired cases (excluded from execution — retirement is visible, never silent)");
    for (const r of results.retiredCases) lines.push(`- **${r.id}**: ${r.retirement_reason}`);
    lines.push("");
  }

  return lines.join("\n");
}
