#!/usr/bin/env python3
"""Pipeline arg contract guard (TEAM-4563 / TEAM-4580).

The CodeBuild projects and CodePipeline actions in deploy/pipeline/lib/
pipeline-stack.ts PROVIDE env vars; the buildspecs in deploy/pipeline/ CONSUME
them. Nothing checked that the two agree, and agreeing with the stack SOURCE is
not enough: PR #576 (TEAM-4525) made buildspec-deploy.yml and
buildspec-runtime-images.yml read DEPLOY_PREAPPROVED, which pipeline-stack.ts
provides as an action-level #{BuildVars.DEPLOY_PREAPPROVED}. Source and buildspec
agreed - but ./deploy/pipeline/deploy.sh is a HANDOFF a human runs and it had not
run, CodePipeline resolves an unknown variable to "", and every main deploy failed
at PRE_BUILD until a human redeployed the stack and PR #579 (TEAM-4527) made
preapproved-check.sh gate tolerate empty.

That is the source-vs-deployed nuance, and it is why the contract is never
generated: a contract derived from pipeline-stack.ts would have passed #576
unchanged. deploy/pipeline/pipeline-contract.json is instead a hand-advanced
declaration of what the DEPLOYED pipeline provides, and this guard is asymmetric:

  * a contract entry MUST exist in stack source - the contract cannot invent an
    arg (rules P1-P3);
  * a stack-source arg MISSING from the contract is legal and means "declared in
    source, not yet confirmed deployed" - but any buildspec that READS it fails
    here until a human deploys the stack and advances the contract (rule P4).

D10: DEFINED is whole-file and ORDER-INSENSITIVE - functions are defined before
they are called and CodeBuild runs all phases of a buildspec in one shell, so a
read above a later definition of the same name is not a violation. The #576
class is an arg the stack never provides, not an ordering mistake.

Runs on both CI rails (.github/workflows/ci.yml and buildspec-ci.yml) via
scripts/check-pipeline-contract.sh. Same pass shape as check-deploy-surfaces.sh:
stdlib only (argparse, glob, json, re, sys, pathlib.Path), no AWS, no network, it
spawns no child process, reads no environment variable (configuration is argparse
only) and never writes a file. The stack is parsed textually (no node/tsc/cdk) and
the buildspecs with `re` only, no third-party YAML parser.

Exit codes: 0 pass, 1 contract violation(s) (all collected, deduped, sorted, one
FAIL: line each on stderr), 2 infrastructure error (first error only, one FAIL:
line). See docs/pipeline/design.md and deploy/pipeline/README.md.
"""
import argparse
import glob
import json
import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
UPPER_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


class Infra(Exception):
    """Infrastructure error -> exit 2 with exactly one FAIL: line."""


# -----------------------------------------------------------------------------
# Stack parse (D19) -- textual, single pass, no node/tsc/cdk
# -----------------------------------------------------------------------------

def strip_ts_comments(src, path):
    """Return (code, masked). code = src with // and /* */ comments replaced by
    spaces (newlines kept). masked = code with string-literal CONTENTS replaced by
    spaces (quotes kept, same length) so brace walks ignore {/} inside strings.
    Honours "...", '...', and `...` template literals incl. ${ ... } nesting.
    Unterminated string or block comment -> Infra."""
    code = []
    masked = []
    n = len(src)
    i = 0
    # stack entries: 'code' | 'dq' | 'sq' | 'tpl' | ['expr', depth]
    stack = ["code"]

    def line_of(pos):
        return src.count("\n", 0, pos) + 1

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        top = stack[-1]
        if top == "code" or isinstance(top, list):
            if c == "/" and nxt == "/":
                j = src.find("\n", i)
                if j < 0:
                    j = n
                code.append(" " * (j - i))
                masked.append(" " * (j - i))
                i = j
                continue
            if c == "/" and nxt == "*":
                j = src.find("*/", i + 2)
                if j < 0:
                    raise Infra("%s:%d: unterminated block comment" % (path, line_of(i)))
                seg = src[i:j + 2]
                blank = "".join("\n" if ch == "\n" else " " for ch in seg)
                code.append(blank)
                masked.append(blank)
                i = j + 2
                continue
            if c == '"':
                stack.append("dq")
            elif c == "'":
                stack.append("sq")
            elif c == "`":
                stack.append("tpl")
            elif isinstance(top, list):
                if c == "{":
                    top[1] += 1
                elif c == "}":
                    top[1] -= 1
                    if top[1] == 0:
                        stack.pop()
            code.append(c)
            masked.append(c)
            i += 1
            continue
        if top in ("dq", "sq"):
            q = '"' if top == "dq" else "'"
            if c == "\\":
                code.append(src[i:i + 2])
                masked.append("  ")
                i += 2
                continue
            if c == "\n":
                raise Infra("%s:%d: unterminated string literal" % (path, line_of(i)))
            if c == q:
                stack.pop()
                code.append(c)
                masked.append(c)
            else:
                code.append(c)
                masked.append(" ")
            i += 1
            continue
        if top == "tpl":
            if c == "\\":
                code.append(src[i:i + 2])
                masked.append(" " + ("\n" if nxt == "\n" else " "))
                i += 2
                continue
            if c == "`":
                stack.pop()
                code.append(c)
                masked.append(c)
                i += 1
                continue
            if c == "$" and nxt == "{":
                stack.append(["expr", 1])
                code.append("${")
                masked.append("${")
                i += 2
                continue
            code.append(c)
            masked.append("\n" if c == "\n" else " ")
            i += 1
            continue
        raise AssertionError("bad state")
    if len(stack) != 1:
        raise Infra("%s: unterminated string or template literal at end of file" % path)
    code_s = "".join(code)
    masked_s = "".join(masked)
    assert len(code_s) == len(masked_s) == len(src)
    return code_s, masked_s


def brace_walk(masked, open_idx, path):
    """masked[open_idx] must be '{'; return index of the matching '}'."""
    assert masked[open_idx] == "{"
    depth = 0
    for k in range(open_idx, len(masked)):
        ch = masked[k]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return k
    raise Infra("%s:%d: unbalanced braces after offset %d" % (path, masked.count("\n", 0, open_idx) + 1, open_idx))


RE_COMMON = re.compile(r"\bconst\s+commonEnvVars\b[^=]*=\s*\{")
RE_ENVVARS = re.compile(r"\benvironmentVariables\s*:\s*")
RE_PROJECTNAME = re.compile(r"\bprojectName\s*:\s*")
RE_ACTIONNAME = re.compile(r"\bactionName\s*:\s*")
RE_NAMESPACE = re.compile(r"\bvariablesNamespace\s*:\s*")
RE_FROMSOURCE = re.compile(r"\bfromSourceFilename\(\s*")
RE_CONSTPROJECT = re.compile(r"\bconst\s+(\w+)\s*=\s*new\s+codebuild\.(?:Pipeline)?Project\(")
RE_PROJECTBIND = re.compile(r"\bproject\s*:\s*(\w+)\s*,")
RE_STRING_AT = re.compile(r'"([^"]*)"')
RE_ENV_KEY = re.compile(r'^\s*(?:\.\.\.(\w+)|([A-Za-z_]\w*)|"([^"]+)")\s*(?::|,|$)')
RE_TOKEN = re.compile(r"#\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\}")


def _string_after(code, masked, pos, what, path):
    """masked[pos] must start a "..." literal; return (value from UNMASKED code, end)."""
    if pos >= len(masked) or masked[pos] != '"':
        raise Infra("%s:%d: %s is not a string literal" % (path, masked.count("\n", 0, pos) + 1, what))
    m = RE_STRING_AT.match(code, pos)
    if not m:
        raise Infra("%s:%d: %s string literal not terminated on this line" % (path, masked.count("\n", 0, pos) + 1, what))
    return m.group(1), m.end()


def _split_entries(seg):
    """Split one depth-1 env-block segment into (offset, text) entries at commas
    that are not nested. seg comes from the MASKED source, so a comma inside a
    string literal is already blanked; braces, brackets and parens are tracked so
    a comma inside `{ value: f(a, b) }` cannot split an entry."""
    out = []
    depth = 0
    start = 0
    for i, ch in enumerate(seg):
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append((start, seg[start:i]))
            start = i + 1
    out.append((start, seg[start:]))
    return out


def parse_stack(path_str):
    """Return the stack-source view (D19 step 6)."""
    p = Path(path_str)
    if not p.is_file():
        raise Infra("%s: stack file missing" % path_str)
    try:
        src = p.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        raise Infra("%s: not valid UTF-8 (%s)" % (path_str, e))
    src = src.replace("\r\n", "\n")
    code, masked = strip_ts_comments(src, path_str)

    def line_of(pos):
        return code.count("\n", 0, pos) + 1

    # (3) anchors
    commons = list(RE_COMMON.finditer(masked))
    if len(commons) != 1:
        raise Infra("%s: expected exactly one `const commonEnvVars = {` block, found %d" % (path_str, len(commons)))
    anchors = []  # (offset, kind, name)
    for m in RE_PROJECTNAME.finditer(masked):
        val, _ = _string_after(code, masked, m.end(), "projectName", path_str)
        anchors.append((m.start(), "project", val, line_of(m.start())))
    for m in RE_ACTIONNAME.finditer(masked):
        val, _ = _string_after(code, masked, m.end(), "actionName", path_str)
        anchors.append((m.start(), "action", val, line_of(m.start())))
    anchors.sort()
    if not anchors:
        raise Infra("%s: no projectName:/actionName: literals found" % path_str)

    def owner(pos, what):
        best = None
        for a in anchors:
            if a[0] < pos:
                best = a
            else:
                break
        if best is None:
            raise Infra("%s:%d: %s has no preceding projectName:/actionName:" % (path_str, line_of(pos), what))
        return best

    providers = {}
    kinds = {}
    for _, kind, name, _ln in anchors:
        providers.setdefault(name, {})
        kinds[name] = kind
    var_lines = {}

    # (4) env-block key extraction
    def block_keys(open_idx, what):
        close = brace_walk(masked, open_idx, path_str)
        keys = []  # (key, line, is_spread)
        depth = 1
        k = open_idx + 1
        line_start = k
        line_depth = 1
        while k <= close:
            ch = masked[k]
            if ch == "\n" or k == close:
                seg_end = min(k, close)
                if line_depth == 1 and line_start < seg_end:
                    seg = masked[line_start:seg_end]
                    if seg.strip():
                        for off, piece in _split_entries(seg):
                            if not piece.strip():
                                continue
                            base = line_start + off
                            mk = RE_ENV_KEY.match(piece)
                            if not mk:
                                raise Infra("%s:%d: unrecognised entry in %s block: %r" % (path_str, line_of(base), what, code[base:base + len(piece)].strip()))
                            if mk.group(1) is not None:
                                if mk.group(1) != "commonEnvVars":
                                    raise Infra("%s:%d: spread of %s in %s block (only ...commonEnvVars is understood)" % (path_str, line_of(base), mk.group(1), what))
                                keys.append(("...commonEnvVars", line_of(base), True))
                            else:
                                s, e = (mk.span(2) if mk.group(2) is not None else mk.span(3))
                                keys.append((code[base + s:base + e], line_of(base), False))
                line_start = k + 1
                line_depth = depth
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            k += 1
        return keys

    common_vars = {}
    cm = commons[0]
    for key, ln, spread in block_keys(cm.end() - 1, "commonEnvVars"):
        if spread:
            raise Infra("%s:%d: commonEnvVars may not spread" % (path_str, ln))
        if UPPER_RE.match(key):
            common_vars[key] = ln
    common_line = line_of(cm.start())

    for m in RE_ENVVARS.finditer(masked):
        pos = m.end()
        own = owner(m.start(), "environmentVariables")
        name, kind = own[2], own[1]
        if masked[pos] == "{":
            for key, ln, spread in block_keys(pos, "environmentVariables"):
                if spread:
                    for v, vl in common_vars.items():
                        providers[name][v] = "common"
                        var_lines[(name, v)] = vl
                elif UPPER_RE.match(key):
                    providers[name][key] = kind
                    var_lines[(name, key)] = ln
        else:
            mi = re.match(r"(\w+)", masked[pos:])
            ident = mi.group(1) if mi else ""
            if ident != "commonEnvVars":
                raise Infra("%s:%d: environmentVariables bound to %r (only a { block } or commonEnvVars is understood)" % (path_str, line_of(pos), ident))
            for v, vl in common_vars.items():
                providers[name][v] = "common"
                var_lines[(name, v)] = vl

    namespaces = {}
    for m in RE_NAMESPACE.finditer(masked):
        val, _ = _string_after(code, masked, m.end(), "variablesNamespace", path_str)
        own = owner(m.start(), "variablesNamespace")
        if own[1] != "action":
            raise Infra("%s:%d: variablesNamespace attributed to a project, not an action" % (path_str, line_of(m.start())))
        namespaces[val] = own[2]

    buildspec_of_project = {}
    for m in RE_FROMSOURCE.finditer(masked):
        val, _ = _string_after(code, masked, m.end(), "fromSourceFilename", path_str)
        own = owner(m.start(), "fromSourceFilename")
        if own[1] != "project":
            raise Infra("%s:%d: fromSourceFilename attributed to an action" % (path_str, line_of(m.start())))
        buildspec_of_project[own[2]] = val

    binding = {}
    for m in RE_CONSTPROJECT.finditer(masked):
        ident = m.group(1)
        first = None
        for a in anchors:
            if a[0] > m.start() and a[1] == "project":
                first = a
                break
        if first is None:
            raise Infra("%s:%d: const %s = new codebuild.*Project( has no following projectName:" % (path_str, line_of(m.start()), ident))
        binding[ident] = first[2]

    project_of_action = {}
    for m in RE_PROJECTBIND.finditer(masked):
        ident = m.group(1)
        own = owner(m.start(), "project:")
        if own[1] != "action":
            raise Infra("%s:%d: project: binding attributed to a project" % (path_str, line_of(m.start())))
        if ident not in binding:
            raise Infra("%s:%d: project: %s is not a `const %s = new codebuild.*Project(` binding" % (path_str, line_of(m.start()), ident, ident))
        project_of_action[own[2]] = binding[ident]

    tokens = []
    for m in RE_TOKEN.finditer(code):
        tokens.append((line_of(m.start()), m.group(1), m.group(2)))

    return {
        "path": path_str,
        "providers": providers,
        "kinds": kinds,
        "namespaces": namespaces,
        "buildspec_of_project": buildspec_of_project,
        "project_of_action": project_of_action,
        "tokens": tokens,
        "var_lines": var_lines,
        "common_vars": common_vars,
        "common_line": common_line,
        "anchors": anchors,
    }


# -----------------------------------------------------------------------------
# Buildspec scan (D3-D10, D16-D18)
# -----------------------------------------------------------------------------

RE_BLOCK_OPEN = re.compile(r"^(\s*)(?:-\s*|[A-Za-z_-]+\s*:\s*)\|[-+0-9]*\s*(#.*)?$")
RE_FOLD_OPEN = re.compile(r"^(\s*)(?:-\s*|[A-Za-z_-]+\s*:\s*)>[-+0-9]*\s*(#.*)?$")
RE_PLAIN_ITEM = re.compile(r"^(\s*)-\s+(?![\"'|>#])(\S.*)$")
RE_PLAIN_KEYVAL = re.compile(r"^(\s*)[A-Za-z_][A-Za-z0-9_-]*\s*:[ \t]+(?![\"'|>#])(\S.*)$")
RE_MAPKEY_ISH = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*\s*:(\s|$)")
RE_DQ_SCALAR = re.compile(r'^(\s*)-\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$')
RE_SQ_SCALAR = re.compile(r"^(\s*)-\s*'((?:[^']|'')*)'\s*(#.*)?$")
RE_DQ_OPEN = re.compile(r'^(\s*)-\s*"')
RE_SQ_OPEN = re.compile(r"^(\s*)-\s*'")
RE_ENV_TOP = re.compile(r"^env:\s*(#.*)?$")
RE_ENV_SUBKEY = re.compile(r"^(\s+)([A-Za-z_-]+)\s*:\s*(.*)$")
RE_ENV_MAPKEY = re.compile(r'^\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:')
RE_ENV_LISTITEM = re.compile(r'^\s+-\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(#.*)?$')


def load_text(path_str):
    p = Path(path_str)
    if not p.is_file():
        raise Infra("%s: buildspec file missing" % path_str)
    try:
        t = p.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        raise Infra("%s: not valid UTF-8 (%s)" % (path_str, e))
    return t.replace("\r\n", "\n")


def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _next_content_line(lines, idx):
    """Index of the next non-blank, non-comment-only line after idx, or None."""
    j = idx + 1
    while j < len(lines):
        s = lines[j].strip()
        if s and not s.startswith("#"):
            return j
        j += 1
    return None


def classify_yaml_lines(text, path_str):
    """Return (bash_lines, env_defined, exported) -- one bash-view line per file line.
    A folded (`>`) or plain multi-line scalar is rejected (exit 2): its continuation
    lines would be scanned as separate statements and an argument such as `X=1`
    would read as a definition, hiding the read."""
    lines = text.split("\n")
    out = []
    block_indent = None
    for idx, line in enumerate(lines):
        ln = idx + 1
        if block_indent is not None:
            if line.strip() == "" or _indent(line) > block_indent:
                out.append(line)
                continue
            block_indent = None
        if RE_FOLD_OPEN.match(line):
            raise Infra("unsupported folded multi-line scalar at %s:%d (use a quoted scalar or a | literal block)" % (path_str, ln))
        m = RE_BLOCK_OPEN.match(line)
        if m:
            block_indent = len(m.group(1))
            out.append(line)
            continue
        m = RE_DQ_SCALAR.match(line)
        if m:
            content = m.group(2).replace('\\"', '"').replace("\\\\", "\\")
            out.append(m.group(1) + content)
            continue
        m = RE_SQ_SCALAR.match(line)
        if m:
            out.append(m.group(1) + m.group(2).replace("''", "'"))
            continue
        if RE_DQ_OPEN.match(line) or RE_SQ_OPEN.match(line):
            raise Infra("unsupported multi-line quoted scalar at %s:%d" % (path_str, ln))
        m = RE_PLAIN_ITEM.match(line)
        plain = bool(m) and not RE_MAPKEY_ISH.match(m.group(2))
        if not plain:
            plain = RE_PLAIN_KEYVAL.match(line) is not None
        if plain:
            nxt = _next_content_line(lines, idx)
            if nxt is not None and _indent(lines[nxt]) > _indent(line):
                raise Infra("unsupported plain multi-line scalar at %s:%d (use a quoted scalar)" % (path_str, ln))
        out.append(line)

    # env: block
    env_defined = set()
    exported = []
    for idx, line in enumerate(lines):
        if RE_ENV_TOP.match(line):
            child_indent = None
            section = None
            j = idx + 1
            while j < len(lines):
                l2 = lines[j]
                if l2.strip() == "" or l2.lstrip().startswith("#"):
                    j += 1
                    continue
                ind = _indent(l2)
                if ind == 0:
                    break
                if child_indent is None:
                    child_indent = ind
                if ind == child_indent:
                    mk = RE_ENV_SUBKEY.match(l2)
                    section = mk.group(2) if mk else None
                elif section in ("variables", "parameter-store", "secrets-manager"):
                    mk = RE_ENV_MAPKEY.match(l2)
                    if mk:
                        env_defined.add(mk.group(1))
                elif section == "exported-variables":
                    mk = RE_ENV_LISTITEM.match(l2)
                    if mk:
                        exported.append(mk.group(1))
                        env_defined.add(mk.group(1))
                j += 1
            break
    return out, env_defined, exported


def strip_bash_comments(text):
    """D5: '#' starts a comment when it is at line start or after whitespace, the
    next char is not '{', and it is outside BOTH quote kinds - a '"' toggles the
    double-quoted state only outside single quotes and a "'" toggles the
    single-quoted state only outside double quotes, so a '#' inside 'single
    quotes' is data (a backslash escapes only outside single quotes, as in bash).
    Comment text -> spaces (offsets preserved)."""
    out_lines = []
    for line in text.split("\n"):
        in_dq = False
        in_sq = False
        k = 0
        cut = None
        while k < len(line):
            ch = line[k]
            if ch == "\\" and not in_sq:
                k += 2
                continue
            if ch == '"' and not in_sq:
                in_dq = not in_dq
            elif ch == "'" and not in_dq:
                in_sq = not in_sq
            elif ch == "#" and not in_dq and not in_sq:
                prev_ws = (k == 0) or line[k - 1].isspace()
                nxt = line[k + 1] if k + 1 < len(line) else ""
                if prev_ws and nxt != "{":
                    cut = k
                    break
            k += 1
        if cut is not None:
            line = line[:cut] + " " * (len(line) - cut)
        out_lines.append(line)
    return "\n".join(out_lines)


RE_HEREDOC = re.compile(r"(?<!<)<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def blank_heredocs(text, path_str):
    """D7. Returns (read_text_base, walk_text_base): quoted-tag bodies blanked in
    both; unquoted-tag bodies kept for reads but blanked for the definition walker
    (a heredoc body is data, not statements)."""
    lines = text.split("\n")
    read_lines = list(lines)
    walk_lines = list(lines)
    i = 0
    n = len(lines)
    while i < n:
        search_from = i + 1
        last_end = None
        for m in RE_HEREDOC.finditer(lines[i]):
            tag = m.group(2)
            quoted = m.group(1) != ""
            term = re.compile(r"^\s*" + re.escape(tag) + r"\s*$")
            k = search_from
            while k < n and not term.match(lines[k]):
                k += 1
            if k >= n:
                raise Infra("%s:%d: unterminated heredoc <<%s" % (path_str, i + 1, tag))
            for b in range(search_from, k):
                walk_lines[b] = " " * len(lines[b])
                if quoted:
                    read_lines[b] = " " * len(lines[b])
            search_from = k + 1
            last_end = k
        i = (last_end + 1) if last_end is not None else i + 1
    return "\n".join(read_lines), "\n".join(walk_lines)


def remove_escapes(text):
    """D17: `\\\\` -> two spaces, then `\\$` -> two spaces."""
    return text.replace("\\\\", "  ").replace("\\$", "  ")


RE_READ_BARE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
RE_READ_BRACED = re.compile(r"\$\{[#!]?([A-Za-z_][A-Za-z0-9_]*)")
RE_ARITH = re.compile(r"\$?\(\((.*?)\)\)", re.S)
RE_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
ARITH_SKIP_PREV = set("${#")


def _tolerant_at(text, pos, name):
    return re.match(r"\$\{" + re.escape(name) + r":?[-+]", text[pos:pos + len(name) + 4]) is not None


def extract_reads(read_text, lo=0, hi=None):
    """Return list of (name, offset, form) for every $NAME / ${NAME...} in [lo,hi),
    plus every bare identifier inside a $(( ... )) / (( ... )) arithmetic span - a
    bare identifier there IS a variable reference (`(( X > 0 ))` reads X)."""
    if hi is None:
        hi = len(read_text)
    seg = read_text[lo:hi]
    reads = []
    for m in RE_READ_BARE.finditer(seg):
        reads.append((m.group(1), lo + m.start(), "bare"))
    for m in RE_READ_BRACED.finditer(seg):
        form = "tolerant" if _tolerant_at(seg, m.start(), m.group(1)) else "bare"
        reads.append((m.group(1), lo + m.start(), form))
    for m in RE_ARITH.finditer(seg):
        base = m.start(1)
        for im in RE_IDENT.finditer(m.group(1)):
            k = base + im.start()
            if k > 0 and seg[k - 1] in ARITH_SKIP_PREV:
                continue
            reads.append((im.group(0), lo + k, "bare"))
    return reads


# -- the word walker (D8) -----------------------------------------------------
WORD_DELIMS = set(" \t\n;&|(){}`")
KEYWORDS = {"then", "do", "else", "elif", "if", "while", "until", "!", "time", "env", "nohup", "exec", "command"}
RE_ASSIGN = re.compile(r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<idx>\[[^\]]*\])?\+?=(?P<rhs>.*)$", re.S)
READ_ARG_FLAGS = set("dnNtupai")
MAPFILE_ARG_FLAGS = set("dnOsuCc")


def consume_word(text, i, hi):
    """Consume one shell word starting at text[i]. Returns (end, subs) where subs
    are (start, end) spans of $( ... ) / `...` command substitutions found inside
    the word (outside single quotes), at any depth."""
    subs = []
    stack = []  # entries: [closer, kind, start]
    start = i
    while i < hi:
        c = text[i]
        nxt = text[i + 1] if i + 1 < hi else ""
        if not stack:
            if c == "\\":
                i += 2
                continue
            if c == "'":
                j = text.find("'", i + 1, hi)
                i = hi if j < 0 else j + 1
                continue
            if c == '"':
                stack.append(['"', "dq", i])
                i += 1
                continue
            if c == "$" and nxt == "(":
                stack.append([")", "sub", i + 2])
                i += 2
                continue
            if c == "$" and nxt == "{":
                stack.append(["}", "param", i + 2])
                i += 2
                continue
            if c == "`":
                stack.append(["`", "bt", i + 1])
                i += 1
                continue
            if c == "(" and i > start and text[i - 1] == "=":
                stack.append([")", "array", i + 1])
                i += 1
                continue
            if c in WORD_DELIMS:
                break
            i += 1
            continue
        top = stack[-1]
        if top[1] == "dq":
            if c == "\\":
                i += 2
                continue
            if c == '"':
                stack.pop()
                i += 1
                continue
            if c == "$" and nxt == "(":
                stack.append([")", "sub", i + 2])
                i += 2
                continue
            if c == "$" and nxt == "{":
                stack.append(["}", "param", i + 2])
                i += 2
                continue
            if c == "`":
                stack.append(["`", "bt", i + 1])
                i += 1
                continue
            i += 1
            continue
        if top[1] == "bt":
            if c == "\\":
                i += 2
                continue
            if c == "`":
                stack.pop()
                subs.append((top[2], i))
                i += 1
                continue
            i += 1
            continue
        # code context inside $( ), ${ }, ( ) array, or plain nesting
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1, hi)
            i = hi if j < 0 else j + 1
            continue
        if c == '"':
            stack.append(['"', "dq", i])
            i += 1
            continue
        if c == "`":
            stack.append(["`", "bt", i + 1])
            i += 1
            continue
        if c == "$" and nxt == "(":
            stack.append([")", "sub", i + 2])
            i += 2
            continue
        if c == "$" and nxt == "{":
            stack.append(["}", "param", i + 2])
            i += 2
            continue
        if c == "(":
            stack.append([")", "paren", i + 1])
            i += 1
            continue
        if c == "{":
            stack.append(["}", "brace", i + 1])
            i += 1
            continue
        if c == top[0]:
            stack.pop()
            if top[1] == "sub":
                subs.append((top[2], i))
            i += 1
            continue
        i += 1
    return i, subs


class Defs:
    def __init__(self):
        self.defined = {}   # name -> first line
        self.selfref = {}   # name -> lines (assignments that were reads)
        self.export_reads = []  # (name, offset)


def _line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def _assign(word, w_start, read_text, defs, walk_text):
    """Apply the assignment / self-ref rule (D9) to one word. Returns True if the
    word was an assignment (def or self-ref read)."""
    m = RE_ASSIGN.match(word)
    if not m:
        return False
    name = m.group("name")
    rhs_lo = w_start + m.start("rhs")
    rhs_hi = w_start + len(word)
    rhs_names = {r[0] for r in extract_reads(read_text, rhs_lo, rhs_hi)}
    if name in rhs_names:
        defs.selfref.setdefault(name, []).append(_line_of(walk_text, w_start))
    else:
        defs.defined.setdefault(name, _line_of(walk_text, w_start))
    return True


def scan_statements(walk_text, read_text, lo, hi, defs):
    """D8: definitions only in statement position. Words are consumed by consume_word;
    $( ... ) / `...` bodies are scanned recursively."""
    i = lo
    stmt = True
    pending = None  # builtin handler state: (kind, flagsdone)
    while i < hi:
        c = walk_text[i]
        if c in " \t":
            i += 1
            continue
        if c == "\\" and i + 1 < hi and walk_text[i + 1] == "\n":
            i += 2
            continue
        if c == "\n" or c in ";&|(){}`":
            i += 1
            stmt = True
            pending = None
            continue
        w_start = i
        i, subs = consume_word(walk_text, i, hi)
        word = walk_text[w_start:i]
        for s in subs:
            scan_statements(walk_text, read_text, s[0], s[1], defs)
        if pending is not None:
            kind, state = pending
            if word.startswith("-") and kind != "for" and kind != "select":
                letters = set(word[1:])
                if kind == "read" and letters & READ_ARG_FLAGS and len(word) == 2:
                    state["skip"] = True
                elif kind in ("mapfile", "readarray") and letters & MAPFILE_ARG_FLAGS and len(word) == 2:
                    state["skip"] = True
                continue
            if state.get("skip"):
                state["skip"] = False
                continue
            if kind in ("export", "readonly"):
                if _assign(word, w_start, read_text, defs, walk_text):
                    continue
                if NAME_RE.match(word):
                    defs.export_reads.append((word, w_start))
                    continue
                pending = None
                continue
            if kind in ("declare", "typeset", "local"):
                if _assign(word, w_start, read_text, defs, walk_text):
                    continue
                if NAME_RE.match(word):
                    defs.defined.setdefault(word, _line_of(walk_text, w_start))
                    continue
                pending = None
                continue
            if kind == "read":
                if word.startswith("<") or not NAME_RE.match(word):
                    pending = None
                    continue
                defs.defined.setdefault(word, _line_of(walk_text, w_start))
                continue
            if kind in ("mapfile", "readarray", "for", "select"):
                if NAME_RE.match(word):
                    defs.defined.setdefault(word, _line_of(walk_text, w_start))
                pending = None
                continue
            pending = None
            continue
        if stmt:
            if _assign(word, w_start, read_text, defs, walk_text):
                continue  # prefix chain: stay in statement position
            if word in KEYWORDS:
                continue
            if word in ("export", "readonly", "declare", "typeset", "local", "read", "mapfile", "readarray", "for", "select"):
                pending = (word, {})
                stmt = False
                continue
            stmt = False
    return defs


def scan_buildspec(path_str):
    """Full pass pipeline. Returns dict with reads, defined, exported, tokens."""
    text = load_text(path_str)
    bash_lines, env_defined, exported = classify_yaml_lines(text, path_str)
    view = "\n".join(bash_lines)
    stripped = strip_bash_comments(view)
    read_base, walk_text = blank_heredocs(stripped, path_str)
    read_text = remove_escapes(read_base)
    assert len(read_text) == len(walk_text)
    defs = Defs()
    scan_statements(walk_text, read_text, 0, len(walk_text), defs)
    reads = []  # (name, line, form)
    for name, off, form in extract_reads(read_text):
        if UPPER_RE.match(name):
            reads.append((name, _line_of(read_text, off), form))
    for name, off in defs.export_reads:
        if UPPER_RE.match(name):
            reads.append((name, _line_of(walk_text, off), "export"))
    defined = set(defs.defined) | set(env_defined)
    tokens = [(_line_of(stripped, m.start()), m.group(1), m.group(2)) for m in RE_TOKEN.finditer(stripped)]
    return {
        "path": path_str,
        "reads": reads,
        "defined": defined,
        "defined_lines": dict(defs.defined),
        "selfref": defs.selfref,
        "exported": exported,
        "tokens": tokens,
    }


# -----------------------------------------------------------------------------
# Contract (D1, D2, D13, D21, D22)
# -----------------------------------------------------------------------------

TOP_KEYS = {"$comment", "stack", "namespaces", "buildspecs", "allow"}
NS_KEYS = {"$comment", "builtin", "exporter", "action"}
BS_KEYS = {"$comment", "providedBy", "provides"}
ENTRY_KEYS = {"$comment", "source", "since", "comment", "absence"}


def _nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def load_contract(path_str):
    p = Path(path_str)
    if not p.is_file():
        raise Infra("%s: contract file missing" % path_str)
    try:
        data = json.loads(p.read_bytes().decode("utf-8"))
    except UnicodeDecodeError as e:
        raise Infra("%s: not valid UTF-8 (%s)" % (path_str, e))
    except json.JSONDecodeError as e:
        raise Infra("%s: unparseable JSON (%s)" % (path_str, e))
    if not isinstance(data, dict):
        raise Infra("%s: top level must be an object" % path_str)
    for k in data:
        if k not in TOP_KEYS:
            raise Infra("%s: unknown top-level key %r" % (path_str, k))
    for k in ("stack", "namespaces", "buildspecs", "allow"):
        if k not in data:
            raise Infra("%s: missing required key %r" % (path_str, k))
    if not _nonempty_str(data["stack"]):
        raise Infra("%s: \"stack\" must be a non-empty string" % path_str)
    if not isinstance(data["namespaces"], dict):
        raise Infra("%s: \"namespaces\" must be an object" % path_str)
    if not isinstance(data["buildspecs"], dict) or not data["buildspecs"]:
        raise Infra("%s: \"buildspecs\" must be a non-empty object" % path_str)
    if not isinstance(data["allow"], dict):
        raise Infra("%s: \"allow\" must be an object" % path_str)
    for bpath, entry in data["buildspecs"].items():
        if bpath == "$comment":
            continue
        if not isinstance(entry, dict):
            raise Infra("%s: buildspecs[%r] must be an object" % (path_str, bpath))
        for k in entry:
            if k not in BS_KEYS:
                raise Infra("%s: buildspecs[%r]: unknown key %r" % (path_str, bpath, k))
        pb = entry.get("providedBy")
        if not isinstance(pb, list) or not pb or not all(_nonempty_str(x) for x in pb):
            raise Infra("%s: buildspecs[%r].providedBy must be a non-empty list of names" % (path_str, bpath))
        prov = entry.get("provides")
        if not isinstance(prov, dict):
            raise Infra("%s: buildspecs[%r].provides must be an object" % (path_str, bpath))
        for var, e in prov.items():
            if var == "$comment":
                continue
            if not UPPER_RE.match(var):
                raise Infra("%s: buildspecs[%r].provides: %r is not an UPPER_CASE variable name" % (path_str, bpath, var))
            if not isinstance(e, dict):
                raise Infra("%s: buildspecs[%r].provides.%s must be an object" % (path_str, bpath, var))
            for k in e:
                if k not in ENTRY_KEYS:
                    raise Infra("%s: buildspecs[%r].provides.%s: unknown key %r" % (path_str, bpath, var, k))
            if e.get("source") not in ("common", "project", "action"):
                raise Infra("%s: buildspecs[%r].provides.%s.source must be \"common\", \"project\" or \"action\"" % (path_str, bpath, var))
            for req in ("since", "comment"):
                if not _nonempty_str(e.get(req)):
                    raise Infra("%s: buildspecs[%r].provides.%s.%s must be a non-empty string" % (path_str, bpath, var, req))
            if "absence" in e and e["absence"] not in ("required", "tolerated"):
                raise Infra("%s: buildspecs[%r].provides.%s.absence must be \"required\" or \"tolerated\"" % (path_str, bpath, var))
    for ns, e in data["namespaces"].items():
        if ns == "$comment":
            continue
        if not isinstance(e, dict):
            raise Infra("%s: namespaces[%r] must be an object" % (path_str, ns))
        for k in e:
            if k not in NS_KEYS:
                raise Infra("%s: namespaces[%r]: unknown key %r" % (path_str, ns, k))
        if e.get("builtin") is True:
            continue
        if "builtin" in e and e["builtin"] is not False:
            raise Infra("%s: namespaces[%r].builtin must be true or false" % (path_str, ns))
        if not _nonempty_str(e.get("exporter")) or not _nonempty_str(e.get("action")):
            raise Infra("%s: namespaces[%r] needs \"exporter\" and \"action\" (or \"builtin\": true)" % (path_str, ns))
        if e["exporter"] not in data["buildspecs"]:
            raise Infra("%s: namespaces[%r].exporter %r is not a buildspecs key" % (path_str, ns, e["exporter"]))
    for name, reason in data["allow"].items():
        if name == "$comment":
            continue
        if not NAME_RE.match(name):
            raise Infra("%s: allow: %r is not a variable name" % (path_str, name))
        if not _nonempty_str(reason):
            raise Infra("%s: allow.%s must be a non-empty one-line reason" % (path_str, name))
    return data


# -----------------------------------------------------------------------------
# Parity (D18, D20, D21, D13)
# -----------------------------------------------------------------------------

def effective_vars(stack, provider):
    """Vars a build under `provider` sees: its own block, plus (for an action) the
    bound project's block."""
    out = dict(stack["providers"].get(provider, {}))
    proj = stack["project_of_action"].get(provider)
    if proj:
        for v, s in stack["providers"].get(proj, {}).items():
            out.setdefault(v, s)
    return out


def check_parity(contract, contract_path, stack, scan_targets, explain, strict, root):
    """scan_targets: list of (display_path, contract_key, file_path, note).
    `root` is the repo root the contract's relative paths resolve against; it is
    needed only to scan a namespace's exporter buildspec that is not among the
    scanned targets (reachable under --buildspec).
    Violations are (path, line, var, message) where a line-bearing message prints
    as `FAIL: <path>:<line> <message>` and a line-less one as `FAIL: <message>`
    (the path is then part of the message text). Every message ends in a one-line
    fix. The contract is always called by its literal basename pipeline-contract.json
    in the fixed FR-6 phrases, even when --contract points at a fixture file. P5: a
    stack fromSourceFilename path missing a contract entry is itself a violation,
    whatever its name - not just the buildspec-*.yml/*.yaml the CLI globs."""
    viol = set()
    allow = {k for k in contract["allow"] if k != "$comment"}
    names_in_stack = set(stack["providers"])
    S = stack["path"]

    ns_checked = 0
    provided_total = 0

    # D20 / P1-P3: provider bindings and provides-vs-stack, per contract entry
    for K, entry in contract["buildspecs"].items():
        if K == "$comment":
            continue
        pb = entry["providedBy"]
        for p in pb:
            if p not in names_in_stack:
                viol.add((K, 0, p, "%s providedBy names %s, which is neither a projectName nor an actionName in %s - fix: correct the name or remove it from providedBy" % (K, p, S)))
                continue
            if stack["kinds"][p] == "project":
                bs = stack["buildspec_of_project"].get(p)
                if bs != K:
                    viol.add((K, 0, p, "%s providedBy project %s runs %s, not this buildspec - fix: move %s to the entry for %s or fix the stack's fromSourceFilename" % (K, p, bs or "<no buildSpec>", p, bs or "its buildspec")))
            else:
                proj = stack["project_of_action"].get(p)
                if proj is None:
                    viol.add((K, 0, p, "%s providedBy action %s runs no CodeBuild project - fix: remove it from providedBy" % (K, p)))
                elif proj not in pb:
                    viol.add((K, 0, p, "%s providedBy action %s runs project %s, which is not in providedBy - fix: add %s to providedBy" % (K, p, proj, proj)))
        for proj, bs in stack["buildspec_of_project"].items():
            if bs == K and proj not in pb:
                viol.add((K, 0, proj, "%s project %s runs %s but is missing from its providedBy - fix: add %s to buildspecs[\"%s\"].providedBy" % (S, proj, K, proj, K)))
            if bs == K:
                for act, ap in stack["project_of_action"].items():
                    if ap == proj and act not in pb:
                        viol.add((K, 0, act, "%s action %s (project %s) runs %s but is missing from its providedBy - fix: add %s to buildspecs[\"%s\"].providedBy" % (S, act, proj, K, act, K)))
        for var, e in entry["provides"].items():
            if var == "$comment":
                continue
            provided_total += 1
            declared = {}
            for p in pb:
                src = stack["providers"].get(p, {}).get(var)
                if src:
                    declared[p] = src
            if not declared:
                viol.add((K, 0, var, "pipeline-contract.json declares %s for %s but %s provides it to none of [%s] - fix: remove it from the contract or add it to the stack (which is a HANDOFF)" % (var, K, S, ", ".join(pb))))
            elif e["source"] not in declared.values():
                actual = sorted(set(declared.values()))
                viol.add((K, 0, var, "pipeline-contract.json says %s source=%s for %s but %s declares it as %s for %s - fix: set source to %s" % (var, e["source"], K, S, "/".join(actual), ", ".join(sorted(declared)), "/".join(actual))))

    # D21 / N3: stack namespaces vs contract
    for ns, e in contract["namespaces"].items():
        if ns == "$comment" or e.get("builtin") is True:
            continue
        actual = stack["namespaces"].get(ns)
        if actual is None:
            viol.add((S, 0, ns, "%s has no variablesNamespace \"%s\" but pipeline-contract.json declares namespace %s - fix: remove the namespace or add variablesNamespace to the exporter action (a HANDOFF)" % (S, ns, ns)))
        elif actual != e["action"]:
            viol.add((S, 0, ns, "%s declares variablesNamespace \"%s\" on action %s but pipeline-contract.json says action %s - fix: correct namespaces[\"%s\"].action" % (S, ns, actual, e["action"], ns)))

    # P5: a buildspec the STACK runs must have a contract entry, whatever its name
    # (main()'s glob only closes buildspec-*.yml / *.yaml at two fixed locations).
    for proj, bs in stack["buildspec_of_project"].items():
        if bs in contract["buildspecs"]:
            continue
        viol.add((bs, 0, proj, "%s has no contract entry in pipeline-contract.json buildspecs but %s project %s runs it - fix: add buildspecs[\"%s\"] (providedBy + provides) or fix the stack's fromSourceFilename" % (bs, S, proj, bs)))

    scans = {}
    for disp, key, fpath, note in scan_targets:
        scans[key] = (disp, note, scan_buildspec(fpath))

    exported_of = {key: s["exported"] for key, (d, n, s) in scans.items()}

    def check_tokens(display, tokens, note):
        nonlocal ns_checked
        for line, ns, var in tokens:
            ns_checked += 1
            e = contract["namespaces"].get(ns)
            if not isinstance(e, dict):
                viol.add((display, line, var, "references #{%s.%s} but %s is not in pipeline-contract.json namespaces - fix: add the namespace (exporter + action, or builtin: true) or remove the reference%s" % (ns, var, ns, note)))
                continue
            if e.get("builtin") is True:
                continue
            exporter = e["exporter"]
            exported = exported_of.get(exporter)
            if exported is None:
                exported = scan_buildspec(str(Path(root) / exporter))["exported"]
                exported_of[exporter] = exported
            if var not in exported:
                viol.add((display, line, var, "references #{%s.%s} but %s env.exported-variables does not export %s - fix: add %s to exported-variables or remove the reference%s" % (ns, var, exporter, var, var, note)))

    check_tokens(S, stack["tokens"], "")

    for key, (display, note, s) in scans.items():
        entry = contract["buildspecs"][key]
        pb = entry["providedBy"]
        pb_slash = "/".join(pb)
        provides = {v: e for v, e in entry["provides"].items() if v != "$comment"}
        read_names = {r[0] for r in s["reads"]}
        defined = s["defined"]
        consumed = {n for n in read_names if UPPER_RE.match(n) and n not in defined and not n.startswith("CODEBUILD_") and n not in allow}
        allow_hits = {n for n in read_names if n in allow and n not in defined}
        builtin_hits = {n for n in read_names if n.startswith("CODEBUILD_") and n not in defined}
        if explain:
            def L(xs):
                return "[" + ",".join(sorted(xs)) + "]"
            print("EXPLAIN: %s providedBy=%s provides=%s consumed=%s allow=%s builtin=%s defined=%s" % (
                display, L(pb), L(provides), L(consumed), L(allow_hits), L(builtin_hits), L(n for n in defined if UPPER_RE.match(n))))
        for name in sorted(consumed):
            if name in provides:
                continue
            lines = sorted({r[1] for r in s["reads"] if r[0] == name})
            declared_by = sorted(p for p in pb if name in effective_vars(stack, p))
            for ln in lines:
                if declared_by:
                    viol.add((display, ln, name, "reads %s which pipeline-contract.json does not declare for [%s] - declared in pipeline-stack.ts but not in pipeline-contract.json: deploy the stack (./deploy/pipeline/deploy.sh) then add it to the contract, or make the read tolerate absence (${%s:-})%s" % (name, pb_slash, name, note)))
                else:
                    viol.add((display, ln, name, "reads %s which pipeline-contract.json does not declare for [%s] - fix: if the deployed stack provides it (./deploy/pipeline/deploy.sh has run), add it under buildspecs[\"%s\"].provides; otherwise make the read tolerate absence or drop it, or add it to allow with a reason%s" % (name, pb_slash, key, note)))
        check_tokens(display, s["tokens"], note)
        if strict:
            for name, e in provides.items():
                if name not in read_names or name in defined:
                    continue
                reasons = []
                if e.get("absence") == "tolerated":
                    reasons.append("is marked absence=tolerated")
                missing = [p for p in pb if name not in effective_vars(stack, p)]
                if missing:
                    reasons.append("is not provided by %s" % ", ".join(missing))
                if not reasons:
                    continue
                for r in s["reads"]:
                    if r[0] == name and r[2] == "bare":
                        viol.add((display, r[1], name, "reads %s bare but it %s - fix: read it as ${%s:-} because the deployed pipeline may not provide it yet%s" % (name, " and ".join(reasons), name, note)))

    if viol:
        for path, line, var, msg in sorted(viol):
            if line:
                sys.stderr.write("FAIL: %s:%d %s\n" % (path, line, msg))
            else:
                sys.stderr.write("FAIL: %s\n" % msg)
        return 1
    print("OK: pipeline contract - %d buildspecs, %d provided vars, %d namespace refs checked" % (len(scans), provided_total, ns_checked))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="pipeline arg contract guard (TEAM-4563)")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]), help="repo root (default: the checkout this script lives in; contract paths are relative to it)")
    ap.add_argument("--contract", default=None, help="contract JSON (default <root>/deploy/pipeline/pipeline-contract.json)")
    ap.add_argument("--stack", default=None, help="override the contract's stack path")
    ap.add_argument("--buildspec", action="append", default=[], help="scan only this buildspec (repeatable)")
    ap.add_argument("--explain", action="store_true")
    ap.add_argument("--strict-absence", action="store_true")
    ap.add_argument("--emit-from-stack", action="store_true", help="RESERVED (D22): the contract is never generated from the stack")
    args = ap.parse_args(argv)
    try:
        root = Path(args.root)
        if args.emit_from_stack:
            raise Infra("--emit-from-stack is reserved and not implemented; the contract is never generated from the stack (source-vs-deployed)")
        contract_path = args.contract or str(root / "deploy" / "pipeline" / "pipeline-contract.json")
        contract = load_contract(contract_path)
        stack_display = args.stack or contract["stack"]
        stack_path = args.stack or str(root / contract["stack"])
        stack = parse_stack(stack_path)
        stack["path"] = stack_display  # messages name the stack as the contract does
        keys = [k for k in contract["buildspecs"].keys() if k != "$comment"]
        targets = []
        if args.buildspec:
            for bp in args.buildspec:
                p = Path(bp)
                rel = None
                try:
                    rel = str(p.resolve().relative_to(root.resolve())) if p.exists() else None
                except ValueError:
                    rel = None
                if bp in keys:
                    targets.append((bp, bp, str(root / bp), ""))
                elif rel in keys:
                    targets.append((bp, rel, bp, ""))
                else:
                    same = [k for k in keys if Path(k).name == p.name]
                    if len(same) == 1:
                        if not p.is_file():
                            raise Infra("%s: buildspec file missing" % bp)
                        targets.append((bp, same[0], bp, " (contract entry %s)" % same[0]))
                    else:
                        sys.stderr.write("FAIL: %s has no contract entry in pipeline-contract.json buildspecs - fix: add buildspecs[\"%s\"] (providedBy + provides) or remove the file\n" % (bp, bp))
                        return 1
        else:
            for k in sorted(keys):
                targets.append((k, k, str(root / k), ""))
            globbed = set()
            for pat in ("deploy/pipeline/buildspec-*.yml", "deploy/pipeline/buildspec-*.yaml",
                        "buildspec-*.yml", "buildspec-*.yaml"):
                for g in glob.glob(str(root / pat)):
                    globbed.add(str(Path(g).resolve().relative_to(root.resolve())))
            extra = sorted(globbed - set(keys))
            if extra:
                for x in extra:
                    sys.stderr.write("FAIL: %s has no contract entry in pipeline-contract.json buildspecs - fix: add buildspecs[\"%s\"] (providedBy + provides) or remove the file\n" % (x, x))
                return 1
        # buildspec file existence is an infra error (exit 2), checked in sorted order
        for disp, key, fpath, note in sorted(targets, key=lambda t: t[1]):
            if not Path(fpath).is_file():
                raise Infra("%s: buildspec file missing" % fpath)
        return check_parity(contract, contract_path, stack, sorted(targets, key=lambda t: t[1]),
                            args.explain, args.strict_absence, args.root)
    except Infra as e:
        sys.stderr.write("FAIL: %s\n" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())
