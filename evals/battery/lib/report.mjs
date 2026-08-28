// Pure result assembly + check-run markdown (design §2.5). The CI publisher
// job posts renderCheckSummary() output without executing PR code, so this is
// the only surface the gate exposes to reviewers.

const round2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);

// Judge explanations are free-form model output; cap each one so a rambling
// judge cannot bloat the check run (which is capped at 60k chars downstream).
const EXPLANATION_MAX_CHARS = 400;
const truncate = (s, max = EXPLANATION_MAX_CHARS) => {
  const text = String(s);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

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
  configSources,
  flakyFlags = [],
}) {
  return {
    runId,
    configSha,
    baselineSha,
    scoringBackend,
    verdict: suite.verdict,
    failureReasons: suite.failureReasons,
    // Cases lost to infra (transport/deadline/abort) — what made an ERRORED
    // verdict ERRORED instead of FAIL. Still a failing outcome either way.
    infraCases: suite.infraCases ?? [],
    // Where the gating rules came from (base ref vs PR head) and whether the
    // baseline was still a bootstrap placeholder — both decide the verdict.
    configSources: configSources ?? null,
    bootstrapBaseline: suite.bootstrapBaseline ?? false,
    gatingCases: suite.gatingCases ?? [],
    cases: caseResults.map((c) => ({
      id: c.id,
      status: c.status,
      attempt: c.attempt ?? null,
      modelTier: c.modelTier,
      sessionId: c.sessionId ?? null,
      tenant: c.tenant ?? null,
      toolTrajectory: (c.trajectory || []).map((t) => ({ tool: t.tool, argsDigest: t.argsDigest })),
      scores: c.scores || {},
      scoreDetails: c.details || {},
      deltas: suite.deltaRows.filter((r) => r.case === c.id),
      forbiddenHits: c.forbiddenHits || [],
      missingRequiredTools: c.missingRequiredTools || [],
      error: c.error ?? null,
      runtimeSeconds: round2(c.runtimeSeconds ?? null),
      informational: suite.informationalCases.includes(c.id),
    })),
    summary: suite.summary,
    informationalCases: suite.informationalCases,
    retiredCases,
    // Flaky candidates (TEAM-3090): informational only — never part of the verdict.
    flakyFlags: flakyFlags ?? [],
    costEstimateUsd: round2(costEstimateUsd),
    runtimeSeconds: round2(runtimeSeconds),
  };
}

export function renderCheckSummary(results) {
  const lines = [];
  const icon = results.verdict === "PASS" ? "✅" : "❌";
  lines.push(`# Config-evals battery: ${icon} ${results.verdict}`);
  lines.push("");
  if (results.verdict === "ERRORED") {
    lines.push(
      `- ⚠️ **ERRORED** — infra/timeout corrupted ${(results.infraCases || []).length} case(s) ` +
        "(see Non-scored cases). Still a failing check (fail closed); re-run the job rather than hunting for a score regression."
    );
  }
  lines.push(`- **Run:** \`${results.runId}\` @ \`${results.configSha}\``);
  lines.push(`- **Baseline:** \`${results.baselineSha}\` (backend: ${results.scoringBackend})`);
  lines.push(`- **Cost:** $${results.costEstimateUsd} — **Runtime:** ${results.runtimeSeconds}s`);
  if (results.configSources?.baseRef) {
    const sources = Object.entries(results.configSources)
      .filter(([key]) => key !== "baseRef")
      .map(([file, source]) => `${file} ← ${source}`)
      .join("; ");
    lines.push(`- **Gating rules:** ${sources}`);
  }
  lines.push(`- **Gating cases:** ${(results.gatingCases || []).length} compared against the baseline`);
  if (results.bootstrapBaseline) {
    lines.push(
      "- ⚠️ **Bootstrap baseline** — scores below are informational only and the gate cannot pass until the baseline workflow publishes a real baseline."
    );
  }
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

  const caseById = new Map(results.cases.map((c) => [c.id, c]));
  const floorBreaches = gatedRows.filter((r) => r.verdict === "floor_breach");
  if (floorBreaches.length > 0) {
    lines.push("## Floor violations");
    for (const r of floorBreaches) {
      lines.push(`- **${r.case}** / **${r.evaluator}**: ${r.current} < floor ${r.floor}`);
      // TEAM-3090: the responsible evaluator's judge explanation, so a reviewer
      // sees WHY the cell fell without opening the results artifact. This text
      // still flows through the writeRedacted choke point before publication.
      const explanation = caseById.get(r.case)?.scoreDetails?.[r.evaluator]?.explanation;
      if (explanation) lines.push(`  - Judge: ${truncate(explanation)}`);
    }
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
    for (const c of broken) {
      lines.push(`- **${c.id}**: ${c.status}${c.error ? ` — ${c.error}` : ""}`);
      // Judge explanations collected before the case failed (e.g. the
      // evaluators that DID score before an unscored/errored exit) are the
      // only per-evaluator evidence a broken case has — surface them.
      for (const [evaluator, detail] of Object.entries(c.scoreDetails || {})) {
        if (detail?.explanation) lines.push(`  - ${evaluator}: ${truncate(detail.explanation)}`);
      }
    }
    lines.push("");
  }

  if ((results.flakyFlags || []).length > 0) {
    lines.push("## Flaky candidates (informational — never changes the gate verdict)");
    lines.push(
      "Verdict flipped ≥2 times in the last 5 runs on unchanged config. " +
        "Retire via a status:retired PR per evals/battery/README.md."
    );
    for (const f of results.flakyFlags)
      lines.push(
        `- **${f.caseId}**: ${f.flips} flip(s) over the last ${f.window.length} run(s) ` +
          `[${f.window.map((w) => w.verdict).join(" → ")}]`
      );
    lines.push("");
  }

  if (results.retiredCases.length > 0) {
    lines.push("## Retired cases (excluded from execution — retirement is visible, never silent)");
    for (const r of results.retiredCases) lines.push(`- **${r.id}**: ${r.retirement_reason}`);
    lines.push("");
  }

  return lines.join("\n");
}
