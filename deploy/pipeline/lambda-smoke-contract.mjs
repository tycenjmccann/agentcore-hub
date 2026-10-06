#!/usr/bin/env node
/**
 * lambda-smoke-contract.mjs — what the Lambda smokes install and what they accept
 * (TEAM-5337). One module, so the pre-update import smoke
 * (lambda-import-smoke.mjs) and the post-update live canary (lambda-live-smoke.sh)
 * cannot drift apart.
 *
 *   node deploy/pipeline/lambda-smoke-contract.mjs deps <zip>
 *        SDK-less zip: one `name@version` per bare package the zip imports, pinned
 *        by root package.json; exit 1 when one is not declared there.
 *        Bundled zip (ships node_modules/): prints nothing - there is nothing to
 *        install - but exits 1 unless EVERY bare import both resolves inside the
 *        bundle and is declared in the zip's own package.json `dependencies`
 *        (TEAM-5346; see verifyBundledImports).
 *   node deploy/pipeline/lambda-smoke-contract.mjs imports <zip>
 *        the same scan, unpinned: one bare package name per line (both kinds).
 *   node deploy/pipeline/lambda-smoke-contract.mjs payload <kind>
 *        the read-only canary payload for <kind>, as JSON.
 *   node deploy/pipeline/lambda-smoke-contract.mjs judge <kind> [--offline] <file>
 *        exit 0 when the JSON envelope in <file> has the expected shape, else 1.
 *
 * Dependencies are DERIVED from the zip: the hardcoded list the Deploy stage used
 * to install missed @aws-sdk/client-secrets-manager the day gate-contract.mjs
 * started importing it, and a clean install of that list failed the smoke with
 * ERR_MODULE_NOT_FOUND. We install what the zip imports, never what we assume the
 * runtime provides.
 *
 * TEAM-5346 (review r2 of TEAM-5325): a zip that bundles node_modules/ used to be
 * skipped entirely ("self-contained, derive nothing"). workflow-output's bundle
 * declared two SDK packages and imported six, relying on the runtime for the rest;
 * the import smoke - which, correctly, gives a bundled zip no fallback - failed
 * the clean `npm ci --omit=dev` build with ERR_MODULE_NOT_FOUND. The same rule
 * now applies to both kinds: every bare import must be provided by what the zip
 * declares. For a bundle that means `node_modules/<pkg>` is present AND <pkg> is
 * in the zip's package.json `dependencies` (devDependencies are dropped by
 * --omit=dev, so they do not count). Node builtins, bare or `node:`-prefixed, are
 * the only thing the runtime is trusted to provide.
 *
 * Files the deploy manifest ignores (deploy/pipeline/surfaces.json `ignore`:
 * tests, fixtures, docs) are not deployable source even when a files[] dir entry
 * drags them into the zip, so their imports (a test's `vitest`) are not
 * dependencies. The load-bearing entry is `\.test\.mjs$`.
 *
 * The canary is judged on a POSITIVE shape. "Does not mention a module error" let
 * `{isError:true,error:"TypeError: …"}` through; now only the envelopes listed in
 * CANARY_SHAPES pass. The offline shapes are the real envelopes both twins return
 * against the smoke's dead stub endpoints (captured 2026-10-06):
 *   tickets: {"content":[{"text":"Error: connect ECONNREFUSED 127.0.0.1:1"}]}
 *   jira:    {"error":"fetch failed"}
 * They are accepted ONLY offline — a live function that cannot reach its backend
 * fails the deploy.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "../..");
const SOURCE_EXT = /\.(mjs|cjs|js)$/;

// Tool name is prefixed: the Jira twin looks TOOLS[event.tool_name] up verbatim
// (no "___" stripping) and the tickets twin strips the prefix. Both read
// issue_key; ticket_id rides along for any future alias.
export const CANARIES = {
  get_transitions: {
    tool_name: "Tickets___get_transitions",
    parameters: { issue_key: "CANARY-SMOKE", ticket_id: "CANARY-SMOKE" },
  },
  // workflow-output routes `{}` to its Unknown-tool envelope: no I/O at all.
  unknown_tool: {},
};

const textsOf = (r) => [
  ...(typeof r?.error === "string" ? [r.error] : []),
  ...(Array.isArray(r?.content) ? r.content.map((c) => (typeof c?.text === "string" ? c.text : "")) : []),
];
const onlyText = (r, re) => {
  const t = textsOf(r);
  return t.length > 0 && t.every((s) => re.test(s));
};

const CANARY_SHAPES = {
  get_transitions: {
    live: [
      ["transitions envelope", (r) => Array.isArray(r?.transitions)],
      // tickets twin: textResult(`Issue ${key} not found.`)
      ["tickets not-found", (r) => onlyText(r, /^Issue CANARY-SMOKE not found\.$/)],
      // jira twin: jiraFetch throws `Jira API ${status}: ${msg}` → {error}
      ["jira not-found", (r) => onlyText(r, /^Jira API 404\b/)],
    ],
    offline: [
      ["tickets stub unreachable", (r) => onlyText(r, /^Error: connect ECONNREFUSED 127\.0\.0\.1:1$/)],
      ["jira stub unreachable", (r) => onlyText(r, /^fetch failed$/)],
    ],
  },
  unknown_tool: {
    live: [["unknown-tool envelope", (r) => onlyText(r, /^Unknown tool\b/)]],
    offline: [],
  },
};

/**
 * The one canary rule for the import smoke (offline) and the live canary.
 * @returns {{ok: boolean, why: string}}
 */
export function judgeCanaryEnvelope(kind, result, { offline = false } = {}) {
  const shapes = CANARY_SHAPES[kind];
  if (!shapes) return { ok: false, why: `unknown canary kind ${kind}` };
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, why: `no tool envelope (got ${JSON.stringify(result)})` };
  }
  const allowed = [...shapes.live, ...(offline ? shapes.offline : [])];
  const hit = allowed.find(([, pred]) => pred(result));
  if (hit) return { ok: true, why: hit[0] };
  return { ok: false, why: `unexpected ${kind} envelope: ${JSON.stringify(result).slice(0, 500)}` };
}

// ── dependency derivation ──────────────────────────────────────────────────

export function extract(zip, dest) {
  try {
    execFileSync("unzip", ["-q", zip, "-d", dest], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`unzip failed: ${String(err.stderr || err.message).trim()}`);
    execFileSync("python3", ["-m", "zipfile", "-e", zip, dest], { stdio: ["ignore", "ignore", "pipe"] });
  }
}

function stripComments(src) {
  // Strings are kept (specifiers are strings); comments go, so a JSDoc
  // `import("@aws-sdk/lib-dynamodb")` type is not a dependency.
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m, str) => (str ? m : ""));
}

const IMPORT_RES = [
  /\bimport\s+[^'"`;()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bexport\s+[^'"`;()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

let ignoreCache = null;
/** The deploy manifest's `ignore` regexes - what is not deployable source. Read
 *  lazily: lambda-import-smoke.mjs imports this module in its parent AND child,
 *  and lambda-live-smoke.sh uses payload/judge; none of them need the manifest. */
export function manifestIgnorePatterns(surfaces = join(REPO, "deploy/pipeline/surfaces.json")) {
  if (!ignoreCache) {
    const list = JSON.parse(readFileSync(surfaces, "utf8")).ignore || [];
    ignoreCache = list.map((re) => new RegExp(re));
  }
  return ignoreCache;
}

/** Bare packages imported by the sources of `dir` (node_modules/ excluded, and
 *  files matching the manifest `ignore` patterns skipped). */
export function bareImportsOf(dir, { ignore = manifestIgnorePatterns() } = {}) {
  const found = new Set();
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules") walk(p, relPath);
        continue;
      }
      if (!SOURCE_EXT.test(name)) continue;
      if (ignore.some((re) => re.test(relPath))) continue;
      const src = stripComments(readFileSync(p, "utf8"));
      for (const re of IMPORT_RES) {
        for (const m of src.matchAll(re)) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || isBuiltin(spec)) continue;
          found.add(packageOf(spec));
        }
      }
    }
  };
  walk(dir, "");
  return [...found].sort();
}

/** Bare packages the zip's own sources import - for an SDK-less zip and for one
 *  that bundles node_modules/ alike (never null since TEAM-5346). */
export function zipImportsOf(zip) {
  return withExtracted(zip, (tmp) => bareImportsOf(tmp));
}

/** True when the zip ships its own node_modules/. */
export function zipBundlesNodeModules(zip) {
  return withExtracted(zip, (tmp) => existsSync(join(tmp, "node_modules")));
}

function withExtracted(zip, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "lambda-smoke-deps-"));
  try {
    extract(resolve(zip), tmp);
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * TEAM-5346: the bundle contract. For an extracted zip that ships node_modules/,
 * every bare import must (a) resolve inside the bundle - `node_modules/<pkg>/
 * package.json` exists - and (b) be declared in the zip's own package.json
 * `dependencies`. (a) without (b) is a transitive accident the next `npm ci` can
 * undo; (b) without (a) is a stale lockfile or a failed install. A bundle with no
 * package.json cannot declare anything and is refused as such.
 * @returns {{unresolved: string[], undeclared: string[], missingPackageJson: boolean}}
 */
export function verifyBundledImports(dir, imports) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return { unresolved: [], undeclared: [...imports], missingPackageJson: true };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const declared = pkg.dependencies || {};
  const unresolved = imports.filter((n) => !existsSync(join(dir, "node_modules", n, "package.json")));
  const undeclared = imports.filter((n) => !declared[n]);
  return { unresolved, undeclared, missingPackageJson: false };
}

/** The gaps of a bundled zip, as one message, or null when the bundle is whole. */
export function bundleGapMessage({ unresolved, undeclared, missingPackageJson }) {
  const parts = [];
  if (missingPackageJson) parts.push("the zip bundles node_modules/ but ships no package.json to declare its dependencies");
  if (unresolved.length) parts.push(`not in the bundled node_modules: ${unresolved.join(", ")}`);
  if (undeclared.length && !missingPackageJson) parts.push(`not declared in the zip's package.json dependencies: ${undeclared.join(", ")}`);
  if (missingPackageJson && undeclared.length) parts.push(`(its sources import ${undeclared.join(", ")})`);
  return parts.length ? `bundled zip is not self-contained - ${parts.join("; ")}` : null;
}

/** For an SDK-less zip: `name@version` for every bare import, pinned by root
 *  package.json (dependencies, else devDependencies). For a bundled zip: [] after
 *  verifyBundledImports passes; throws naming every gap otherwise. */
export function smokeDepsOf(zip, { packageJson = join(REPO, "package.json") } = {}) {
  return withExtracted(zip, (tmp) => {
    const imports = bareImportsOf(tmp);
    if (existsSync(join(tmp, "node_modules"))) {
      const gap = bundleGapMessage(verifyBundledImports(tmp, imports));
      if (gap) throw new Error(gap);
      return [];
    }
    // dependencies win; devDependencies pin what only a Lambda uses (cost-report's
    // client-cost-explorer). Undeclared anywhere = an unpinned install = refused.
    const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
    const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    const missing = [];
    const specs = imports.map((n) => {
      if (!deps[n]) missing.push(n);
      return `${n}@${deps[n]}`;
    });
    if (missing.length) throw new Error(`zip imports ${missing.join(", ")} but root package.json declares none of them`);
    return specs;
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

function cli(argv) {
  const [cmd, ...rest] = argv;
  const die = (msg, code = 2) => {
    console.error(`lambda-smoke-contract: ${msg}`);
    process.exit(code);
  };
  if (cmd === "deps") {
    if (!rest[0]) die("usage: deps <zip>");
    try {
      for (const s of smokeDepsOf(rest[0])) console.log(s);
    } catch (err) {
      die(err?.message || String(err), 1);
    }
  } else if (cmd === "imports") {
    if (!rest[0]) die("usage: imports <zip>");
    for (const n of zipImportsOf(rest[0])) console.log(n);
  } else if (cmd === "payload") {
    if (!(rest[0] in CANARIES)) die(`unknown canary kind ${rest[0]} (known: ${Object.keys(CANARIES).join(", ")})`);
    console.log(JSON.stringify(CANARIES[rest[0]]));
  } else if (cmd === "judge") {
    const offline = rest.includes("--offline");
    const [kind, file] = rest.filter((a) => a !== "--offline");
    if (!kind || !file) die("usage: judge <kind> [--offline] <file>");
    let body;
    try {
      body = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      die(`response is not JSON: ${err?.message || err}`, 1);
    }
    const v = judgeCanaryEnvelope(kind, body, { offline });
    (v.ok ? console.log : console.error)(v.why);
    process.exit(v.ok ? 0 : 1);
  } else {
    die("usage: deps <zip> | imports <zip> | payload <kind> | judge <kind> [--offline] <file>");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) cli(process.argv.slice(2));
