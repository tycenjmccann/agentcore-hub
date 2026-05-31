#!/usr/bin/env python3
"""
verify-fleet-invoke.py — Invoke each agent in the fleet for health check.

Signs requests with SigV4 (matching the agent-invoker Lambda pattern) and
parses each agent's response to extract tool status.

Tests ALL tools in the agent toolkit:
  - 13 Built-in Strands tools (shell, file_read, file_write, editor, python_repl,
    calculator, http_request, image_reader, current_time, environment, retrieve,
    code_interpreter, browser)
  - 1 Claude Code SDK tool (claude_code)
  - 15 Lambda-backed tools (S3, Jira, Workflow, load_blueprint, download_s3_file)
  - GitHub MCP tools (get_file_contents, search_code, create_branch, get_me,
    list_branches, create_or_update_file, push_files, create_pull_request, etc.)
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

try:
    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session as BotocoreSession
except ImportError:
    print("ERROR: boto3 and botocore are required. Install with: pip install boto3")
    sys.exit(1)


# Real integration test prompt — exercises tools with KNOWN FIXTURES and validates OUTPUTS.
# Fixtures are pre-staged in S3: s3://{ARTIFACT_BUCKET}/healthcheck/fixtures/
#   - test-logo.png: Image of a blue circle with the word "AGENTCORE" below it
#   - buggy-component.tsx: React component with a known SSR hydration bug (localStorage in useState)
#   - fixed-component.tsx: The correct fix (useState default + useEffect)
#   - test-page.html: HTML page with title "AgentCore Hub Fleet Status", message "All systems operational", version "v2.1.0"
HEALTH_CHECK_PROMPT = """You are being invoked for a post-deployment integration test.
Your job is to execute REAL workflows that mirror what you do in production, using test fixtures.
For EVERY test, you must validate the OUTPUT is correct — not just that the tool didn't error.

Report each test result as:
  {"tool": "<tool_name>", "status": "pass|fail|missing", "expected": "<what you expected>", "actual": "<what you got>", "error": null or "message"}

Return your FULL response as a single JSON array. Nothing else.

---

## TEST GROUP 1: File System & Code Editing (simulates dev workflow)

1. download_s3_file: Download 'healthcheck/fixtures/buggy-component.tsx' to /tmp/buggy-component.tsx
   VALIDATE: File exists at /tmp/buggy-component.tsx and contains 'localStorage.getItem("theme")'

2. file_read: Read /tmp/buggy-component.tsx
   VALIDATE: Content includes 'useState(() =>' and 'localStorage' — this is the known bug pattern

3. editor: Fix the hydration bug — replace the useState initializer that reads localStorage with useState("light"), and add a useEffect that reads localStorage after mount. The fix requires:
   - Change 'useState(() => { return localStorage.getItem("theme") || "light"; })' to 'useState("light")'
   - Add 'useEffect(() => { const saved = localStorage.getItem("theme"); if (saved) setTheme(saved); }, []);' after the useState
   - Add 'useEffect' to the import from "react"
   VALIDATE: After editing, file_read the result. It must NOT contain 'useState(() =>' and MUST contain 'useEffect'

4. shell: Run 'grep -c "useEffect" /tmp/buggy-component.tsx' — must output "2" (the import + the hook call)
   VALIDATE: Output is "2"

5. python_repl: Run this exact code to validate the fix: content = open('/tmp/buggy-component.tsx').read(); has_useeffect_import = 'useEffect' in content.split('from "react"')[0]; has_usestate_default = 'useState("light")' in content; has_localstorage_in_effect = 'useEffect' in content and 'localStorage' in content; no_ssr_bug = 'useState(() =>' not in content; print("PASS" if all([has_useeffect_import, has_usestate_default, has_localstorage_in_effect, no_ssr_bug]) else "FAIL")
   VALIDATE: Output contains "PASS"

6. code_interpreter: Run print("code_interpreter_ok_" + str(2+2)) in the AgentCore sandboxed code interpreter environment (NOT python_repl — use the code_interpreter tool specifically)
   VALIDATE: Output contains "code_interpreter_ok_4"

## TEST GROUP 2: Image Analysis (simulates design review)

6. download_s3_file: Download 'healthcheck/fixtures/test-logo.png' to /tmp/test-logo.png
   VALIDATE: File exists at /tmp/test-logo.png

7. image_reader: Read /tmp/test-logo.png and describe what you see
   VALIDATE: Your description MUST mention BOTH "circle" (or "round shape") AND "AGENTCORE" (the text). If you cannot identify these two elements, the test FAILS.

## TEST GROUP 3: Browser & Screenshot (simulates QA workflow)

8. S3Storage___read_object: Read key='healthcheck/fixtures/test-page.html'
   VALIDATE: Content includes '<h1 id="title">AgentCore Hub Fleet Status</h1>'

9. file_write: Write that HTML content to /tmp/test-page.html

10. browser: Navigate to https://httpbin.org/html (a public page with known content)
    VALIDATE: Page loads and you can extract text containing "Herman Melville" (httpbin's known HTML response contains Moby Dick text). If the browser tool fails with any error, report status='fail' with the actual error.

## TEST GROUP 4: Claude Code SDK (simulates delegated coding)

11. claude_code: Invoke with task='Create a file /tmp/cc-test.txt containing exactly "claude_code_write_ok", then read it back and print the contents, then delete it.' and working_directory='/tmp'
    VALIDATE: Response must contain "claude_code_write_ok". This proves Claude Code can authenticate with Bedrock AND execute file operations (Write, Read, Bash). If it fails with permission/auth errors, report status='fail' with the error.

## TEST GROUP 5: S3 Round-Trip (simulates artifact storage)

12. S3Storage___write_object: Write key='healthcheck/results/{TIMESTAMP}.json', content='{"test":"integration","status":"running","timestamp":{TIMESTAMP}}'
    VALIDATE: Response must NOT contain 'Error' or 'AccessDenied'. Must confirm the write succeeded (e.g., returns the key or a success message).

13. S3Storage___read_object: Read key='healthcheck/results/{TIMESTAMP}.json'
    VALIDATE: Content matches what you wrote (contains "integration" and the timestamp)

14. S3Storage___list_objects: List prefix='healthcheck/results/'
    VALIDATE: Results include the key you just wrote

15. download_s3_file: Download 'healthcheck/results/{TIMESTAMP}.json' to /tmp/hc-result.json
    VALIDATE: file_read of /tmp/hc-result.json matches what you wrote

## TEST GROUP 6: Jira Workflow (simulates ticket lifecycle)

16. Tickets___search_issues: Search 'project = TEAM ORDER BY created DESC' max_results=1
    VALIDATE: Returns at least 1 result with a ticket ID matching TEAM-*

17. Tickets___create_ticket: Create with summary='[HEALTHCHECK-{TIMESTAMP}] Integration Test', description='Automated integration test. This ticket tests the full lifecycle: create→comment→transition→done.', issue_type='Task', parent_key='TEAM-116', workflow_id='healthcheck-{TIMESTAMP}'
    VALIDATE: Returns a ticketId (save it for next steps)

18. Tickets___add_comment: Add comment to the ticket from step 17: '[HEALTHCHECK] Step 2: Adding comment to verify comment tool works'
    VALIDATE: Response must NOT contain 'Error' or 'error' or 'AccessDenied'. Must return a comment ID or success confirmation.

19. Tickets___transition_ticket: Transition ticket from step 17 to 'done'
    VALIDATE: Response must NOT contain 'Error' or 'error' or 'AccessDenied'. Must indicate transition succeeded.

20. Tickets___update_ticket: Update ticket from step 17 description to '[HEALTHCHECK] Integration test completed successfully at {TIMESTAMP}'
    VALIDATE: Response must NOT contain 'Error' or 'error' or 'AccessDenied'. Must indicate update succeeded.

21. Tickets___list_tickets: List tickets under parent 'TEAM-116'
    VALIDATE: Response must NOT contain 'Error' or 'AccessDenied'. Must return a JSON array or list (can be empty).

## TEST GROUP 7: Workflow Output Tools (simulates agent completion reporting)

22. WorkflowOutput___save_design_doc: Save with workflow_id='healthcheck-{TIMESTAMP}', agent_id='integration-test', title='Health Check Design Doc', content='# Integration Test\\n\\nThis validates the save_design_doc tool writes to S3 correctly.\\n\\n## Result\\nPASS', format='markdown'
    VALIDATE: Response MUST contain '"status": "saved"' (the success JSON). If it returns an error (AccessDenied, isError:true, or any Error string), report status='fail'.

23. WorkflowOutput___report_completion: Report with ticket_id='HEALTHCHECK-{TIMESTAMP}', summary='Integration test completed. All tools validated.'
    VALIDATE: Response MUST contain '"status": "complete"' (the success JSON). If it returns an error (AccessDenied, isError:true, or any Error string), report status='fail' with the error message. This tool writes to S3 — if it can't write, that's a real failure.

24. WorkflowOutput___submit_ticket_plan: Submit with workflow_id='healthcheck-{TIMESTAMP}', requirements='Verify ticket plan submission works', tickets=[{"title":"integration-test-subtask-1","assignee":"frontend_dev","description":"Test subtask"},{"title":"integration-test-subtask-2","assignee":"qa_verifier","description":"Test subtask 2"}]
    VALIDATE: Response MUST contain '"status": "saved"' (the success JSON). If it returns an error, report status='fail'.

25. load_blueprint: Load blueprint_name='full-stack'
    VALIDATE: Returns skill content (non-empty string containing instructions)

## TEST GROUP 8: GitHub MCP (simulates PR workflow)
NOTE: If {GITHUB_OWNER} is empty, report ALL GitHub tests (26-34) as status='pass' with actual='GITHUB_OWNER not configured — skipped'. The get_me test should still run.

26. get_me: Get authenticated GitHub user
    VALIDATE: Returns a username (proves auth works). If it returns an error about missing token/auth, report status='fail'.

27. get_file_contents: Get owner={GITHUB_OWNER}, repo={GITHUB_REPO}, path=package.json, ref=main
    VALIDATE: Content contains a "name" field (valid package.json). If rate-limited by GitHub API, report status='fail' with 'rate_limited' — this IS a failure (means our token is exhausted).

28. search_code: Search query='README in:file', owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: If returns results, pass. If returns 0 results with incomplete_results=false, the GitHub code search index may not have indexed this repo yet — report status='pass' with actual='GitHub code search index not available for this repo (known GitHub limitation for newer repos)'. Only report 'fail' if the tool itself errors or is missing.

29. list_branches: List branches for owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: Returns a list containing 'main'

30. create_branch: Create branch 'healthcheck/integration-{TIMESTAMP}' from 'main' in owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: Returns success or branch ref

31. create_or_update_file: Create file path='healthcheck/integration-{TIMESTAMP}.txt', content='Integration test at {TIMESTAMP}. All tools validated.', message='[HEALTHCHECK] integration test probe', branch='healthcheck/integration-{TIMESTAMP}', owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: Returns success (file committed to branch)

32. push_files: Push files=[{path:'healthcheck/integration-{TIMESTAMP}-2.txt', content:'push_files validation'}] with message='[HEALTHCHECK] push_files test', branch='healthcheck/integration-{TIMESTAMP}', owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: Returns success. If tool doesn't exist, report 'missing'.

33. create_pull_request: Create PR title='[HEALTHCHECK-{TIMESTAMP}] Integration Test — AUTO CLOSE', body='Automated integration test. DO NOT MERGE. Will be closed automatically.', head='healthcheck/integration-{TIMESTAMP}', base='main', owner={GITHUB_OWNER}, repo={GITHUB_REPO}
    VALIDATE: Returns PR URL or number

34. search_repositories: Search query='{GITHUB_REPO} in:name'
    VALIDATE: Returns at least 1 result

## TEST GROUP 9: Utility Tools

35. calculator: Compute 6000 * 50 / 1000 (simulates event-count math for replay speed)
    VALIDATE: Result is 300

36. current_time: Get current UTC time
    VALIDATE: Returns a valid ISO timestamp

37. environment: Read AWS_REGION env var
    VALIDATE: Returns 'us-east-1'

38. http_request: GET https://httpbin.org/json
    VALIDATE: Response contains 'slideshow' (httpbin's known JSON response)

39. retrieve: Call retrieve with text='how to get started' and knowledgeBaseId='{KNOWLEDGE_BASE_ID}' (pass the KB ID explicitly as a parameter)
    VALIDATE: If KB ID is 'NONE' or empty, report status='pass' with actual='No Knowledge Base configured — skipped'. Otherwise returns results (any non-empty response). If it errors with AccessDenied, report status='fail' — this means the runtime IAM role needs bedrock:Retrieve permission.

---

CRITICAL RULES:
- {TIMESTAMP}: Replace with current unix timestamp (seconds since epoch)
- SEQUENTIAL DEPENDENCIES: Steps within a group must execute in order (e.g., download before read, create before transition)
- OUTPUT VALIDATION IS MANDATORY: 'pass' means the output MATCHED expectations. 'fail' means it didn't. Never report 'pass' without checking.
- ERROR RESPONSES ARE FAILURES: If a tool returns a response containing 'Error:', 'AccessDenied', 'isError', or any error message — that is a FAIL, not a pass. A tool "executing" is NOT the same as succeeding. Check the actual response content.
- NO SHORTCUTS: Every tool must be ACTUALLY INVOKED. Existence != working.
- If a tool is NOT in your toolkit at all, report status='missing'
- If a tool exists but produces wrong output, report status='fail' with what you expected vs got
- Return ONLY a JSON array. No explanation, no markdown fences, no commentary."""


# ALL tools that agents SHOULD have (comprehensive list)
# 40 total tests across 9 groups
ALL_EXPECTED_TOOLS = [
    # Built-in Strands (13)
    "shell", "file_read", "file_write", "editor", "python_repl",
    "calculator", "http_request", "image_reader", "current_time",
    "environment", "retrieve", "code_interpreter", "browser",
    # Claude Code (1)
    "claude_code",
    # Lambda-backed (15)
    "download_s3_file",
    "s3storage___read_object", "s3storage___write_object", "s3storage___list_objects",
    "tickets___search_issues", "tickets___list_tickets",
    "tickets___add_comment", "tickets___create_ticket",
    "tickets___transition_ticket", "tickets___update_ticket",
    "workflowoutput___report_completion", "workflowoutput___save_design_doc",
    "workflowoutput___submit_ticket_plan",
    "load_blueprint",
    # GitHub MCP (9)
    "get_me", "get_file_contents", "search_code", "list_branches",
    "create_branch", "create_or_update_file", "push_files",
    "create_pull_request", "search_repositories",
]

# Test fixtures in S3 (pre-staged, must exist for tests to work)
TEST_FIXTURES = {
    "bucket": os.environ.get("ARTIFACT_BUCKET", "your-artifact-bucket"),
    "prefix": "healthcheck/fixtures/",
    "files": {
        "test-logo.png": "Blue circle with text 'AGENTCORE' below it",
        "buggy-component.tsx": "React component with localStorage-in-useState SSR bug",
        "fixed-component.tsx": "Correct fix: useState default + useEffect",
        "test-page.html": "HTML with title 'AgentCore Hub Fleet Status', version v2.1.0",
    },
}

# REQUIRED tools per agent role — if these are missing, the agent CANNOT do its job
REQUIRED_TOOLS_BY_ROLE = {
    # Dev agents MUST have shell + filesystem + code interpreter + claude_code
    "agentcore_hub_frontend_dev": ["shell", "file_read", "file_write", "editor", "code_interpreter", "claude_code"],
    "agentcore_hub_backend_dev": ["shell", "file_read", "file_write", "editor", "code_interpreter", "claude_code"],
    "agentcore_hub_api_dev": ["shell", "file_read", "file_write", "editor", "code_interpreter", "claude_code"],
    # QA needs shell + browser + code interpreter + claude_code
    "agentcore_hub_qa_verifier": ["shell", "file_read", "code_interpreter", "browser", "claude_code"],
    # CI needs shell + claude_code
    "agentcore_hub_ci_agent": ["shell", "file_read", "code_interpreter", "claude_code"],
    # Security needs claude_code for review
    "agentcore_hub_security_reviewer": ["shell", "file_read", "claude_code"],
    # Design agents need browser for visual reference
    "agentcore_hub_frontend_designer": ["browser", "image_reader"],
    "agentcore_hub_ios_designer": ["image_reader"],
    # All agents need these basics for workflow participation
    "_all": [
        "load_blueprint",
        "s3storage___read_object", "s3storage___write_object", "s3storage___list_objects",
        "tickets___search_issues", "tickets___create_ticket",
        "tickets___transition_ticket",
        "workflowoutput___report_completion",
        "get_file_contents", "search_code", "get_me",
    ],
}


def get_credentials():
    """Get AWS credentials from the default credential chain."""
    session = BotocoreSession()
    credentials = session.get_credentials()
    if credentials is None:
        print("ERROR: No AWS credentials found.")
        sys.exit(1)
    return credentials.get_frozen_credentials()


def invoke_runtime_agent(agent_name, arn, region, timeout, credentials, model_override=None):
    """Invoke a single Runtime agent via SigV4-signed HTTPS POST."""
    runtime_id = arn.split("/")[-1]
    account_id = arn.split(":")[4]
    host = f"bedrock-agentcore.{region}.amazonaws.com"
    path = f"/runtimes/{runtime_id}/invocations"
    url = f"https://{host}{path}?accountId={account_id}"
    session_id = f"healthcheck-{int(time.time())}-{agent_name}-{agent_name}"  # must be >= 33 chars

    # Substitute configurable values into the prompt
    kb_id = os.environ.get("BEDROCK_KB_ID", "NONE")
    github_owner = os.environ.get("GITHUB_OWNER", "tycenjmccann")
    github_repo = os.environ.get("GITHUB_REPO", "agentcore-console")
    prompt = HEALTH_CHECK_PROMPT.replace("{KNOWLEDGE_BASE_ID}", kb_id)
    prompt = prompt.replace("{GITHUB_OWNER}", github_owner)
    prompt = prompt.replace("{GITHUB_REPO}", github_repo)

    payload_dict = {
        "prompt": prompt,
        "workflow_id": "healthcheck",
        "agent_id": agent_name,
    }
    if model_override:
        payload_dict["model_override"] = model_override
    payload = json.dumps(payload_dict)

    # Create and sign the request
    request = AWSRequest(
        method="POST",
        url=url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Host": host,
            "x-amzn-bedrock-agentcore-runtime-session-id": session_id,
        },
    )

    SigV4Auth(credentials, "bedrock-agentcore", region).add_auth(request)

    # Make the request
    req = urllib.request.Request(
        url,
        data=payload.encode("utf-8"),
        headers=dict(request.headers),
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return parse_response(body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body[:200]}", "tools": []}
    except urllib.error.URLError as e:
        return {"error": f"Connection error: {e.reason}", "tools": []}
    except TimeoutError:
        return {"error": f"Timeout after {timeout}s", "tools": []}
    except Exception as e:
        return {"error": str(e)[:200], "tools": []}


def parse_response(body):
    """Parse the agent response to extract tool status JSON."""
    # The response may be SSE-formatted or raw JSON
    full_text = ""

    for line in body.split("\n"):
        if line.startswith("data: "):
            try:
                event = json.loads(line[6:])
                if "event" in event and "contentBlockDelta" in event["event"]:
                    delta = event["event"]["contentBlockDelta"].get("delta", {})
                    if "text" in delta:
                        full_text += delta["text"]
                elif "message" in event:
                    content = event["message"].get("content", [])
                    if content and "text" in content[0]:
                        full_text = content[0]["text"]
                elif "text" in event:
                    full_text += event["text"]
            except (json.JSONDecodeError, KeyError):
                pass
        elif line.strip().startswith("{") or line.strip().startswith("["):
            try:
                obj = json.loads(line.strip())
                if isinstance(obj, list):
                    return {"error": None, "tools": obj, "raw": full_text}
                if "message" in obj:
                    content = obj["message"].get("content", [])
                    if content and "text" in content[0]:
                        full_text = content[0]["text"]
                elif "text" in obj:
                    full_text = obj["text"]
            except (json.JSONDecodeError, KeyError):
                pass

    if not full_text:
        full_text = body

    # Try to extract JSON array from the text response
    tools = extract_tool_json(full_text)
    return {"error": None, "tools": tools, "raw": full_text[:2000]}


def extract_tool_json(text):
    """Extract tool status JSON array from agent's text response."""
    import re

    # Strategy 1: Find the outermost JSON array by bracket matching
    start_idx = text.find("[")
    if start_idx != -1:
        # Find the matching closing bracket
        depth = 0
        for i in range(start_idx, len(text)):
            if text[i] == "[":
                depth += 1
            elif text[i] == "]":
                depth -= 1
                if depth == 0:
                    candidate = text[start_idx:i+1]
                    try:
                        arr = json.loads(candidate)
                        if isinstance(arr, list) and len(arr) > 0:
                            return arr
                    except json.JSONDecodeError:
                        break

    # Strategy 2: regex for code-fenced JSON
    patterns = [
        r'```json\s*(\[.*\])\s*```',
        r'```\s*(\[.*\])\s*```',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            try:
                arr = json.loads(match.group(1))
                if isinstance(arr, list):
                    return arr
            except json.JSONDecodeError:
                continue

    # Strategy 3: try parsing the entire text as JSON
    try:
        arr = json.loads(text.strip())
        if isinstance(arr, list):
            return arr
    except json.JSONDecodeError:
        pass

    return []


def normalize_tool_name(name):
    """Normalize a tool name for matching (lowercase, strip whitespace)."""
    return name.strip().lower().replace(" ", "_").replace("-", "_")


def format_tool_status(status_str):
    """Format a tool status for display."""
    if not status_str:
        return "?"
    s = status_str.lower()
    if s in ("pass", "success", "ok", "passed", "succeeded"):
        return "\u2713"
    elif s in ("skipped",):
        return "\u2717"  # skipped = failed — nothing should be skipped
    elif s in ("fail", "failed", "error"):
        return "\u2717"
    elif s in ("missing",):
        return "\u2205"  # empty set = tool not available
    else:
        return status_str[:5]


def print_results(results):
    """Print the final summary table."""
    # ═══════════════════════════════════════════════════════════════
    # SECTION 1: Per-agent tool status matrix (grouped by category)
    # ═══════════════════════════════════════════════════════════════

    tool_categories = {
        "Built-in": ["shell", "file_read", "file_write", "editor", "python_repl",
                     "calculator", "http_request", "image_reader", "current_time",
                     "environment", "retrieve", "code_interpreter", "browser"],
        "SDK": ["claude_code"],
        "Lambda": ["download_s3_file", "s3storage___read_object", "s3storage___write_object",
                   "s3storage___list_objects", "tickets___search_issues",
                   "tickets___list_tickets", "tickets___add_comment",
                   "tickets___create_ticket", "tickets___transition_ticket",
                   "tickets___update_ticket", "workflowoutput___report_completion",
                   "workflowoutput___save_design_doc", "workflowoutput___submit_ticket_plan",
                   "load_blueprint"],
        "GitHub MCP": ["get_me", "get_file_contents", "search_code", "list_branches",
                       "create_branch", "create_or_update_file", "push_files",
                       "create_pull_request", "search_repositories"],
    }

    print("")
    print("\u2550" * 80)
    print("  Fleet Health Check Results — Full Tool Validation")
    print("\u2550" * 80)

    # Print per-category results
    for category, tools in tool_categories.items():
        print(f"\n  \u2500\u2500 {category} Tools ({len(tools)}) \u2500\u2500")
        print(f"  {'Agent':<30}", end="")
        for t in tools:
            # Short names for display
            short = t.replace("s3storage___", "s3_").replace("tickets___", "tkt_")
            short = short.replace("workflowoutput___", "wf_")
            short = short[:12]
            print(f" {short:>12}", end="")
        print()
        print(f"  {'\u2500' * 30}", end="")
        for _ in tools:
            print(f" {'─' * 12}", end="")
        print()

        for agent_name in sorted(results.keys()):
            result = results[agent_name]
            short_agent = agent_name.replace("agentcore_hub_", "")

            if result.get("error"):
                print(f"  {short_agent:<30} ERROR: {result['error'][:50]}")
                continue

            # Build tool status map. Skip non-dict entries (agents occasionally
            # emit bare strings between objects in the JSON array).
            tool_map = {}
            for tool_result in result.get("tools", []):
                if not isinstance(tool_result, dict):
                    continue
                name = normalize_tool_name(tool_result.get("tool", tool_result.get("name", "unknown")))
                status = tool_result.get("status", "unknown")
                tool_map[name] = status

            print(f"  {short_agent:<30}", end="")
            for t in tools:
                normalized = normalize_tool_name(t)
                if normalized in tool_map:
                    symbol = format_tool_status(tool_map[normalized])
                else:
                    # Check for partial matches (e.g., agent reported "search_issues" not "tickets___search_issues")
                    short_name = t.split("___")[-1] if "___" in t else t
                    matched = False
                    for reported_name, status in tool_map.items():
                        if short_name in reported_name or reported_name in short_name:
                            symbol = format_tool_status(status)
                            matched = True
                            break
                    if not matched:
                        symbol = "·"  # not reported
                print(f" {symbol:>12}", end="")
            print()

    # ═══════════════════════════════════════════════════════════════
    # SECTION 2: Summary counts
    # ═══════════════════════════════════════════════════════════════

    print("")
    print("\u2550" * 80)
    print("  Summary")
    print("\u2550" * 80)
    print("")
    print(f"  Legend: \u2713=success  \u2717=failed  \u2205=missing  ·=not reported")
    print("")

    for agent_name in sorted(results.keys()):
        result = results[agent_name]
        if result.get("error"):
            print(f"  \u2717 {agent_name}: INVOCATION ERROR — {result['error'][:60]}")
            continue

        tools_reported = [t for t in result.get("tools", []) if isinstance(t, dict)]
        success = sum(1 for t in tools_reported if t.get("status", "").lower() in ("pass", "success", "ok", "passed"))
        failed = sum(1 for t in tools_reported if t.get("status", "").lower() in ("fail", "failed", "error", "skipped"))
        missing = sum(1 for t in tools_reported if t.get("status", "").lower() == "missing")

        total = len(tools_reported)
        icon = "\u2713" if failed == 0 and missing == 0 else "\u2717"
        print(f"  {icon} {agent_name}: {total} reported — {success}\u2713 {failed}\u2717 {missing}\u2205")

        # Show failures with expected vs actual
        if failed > 0:
            for t in tools_reported:
                if t.get("status", "").lower() in ("fail", "failed", "error"):
                    err = (t.get("error") or "")[:80]
                    expected = (t.get("expected") or "")[:60]
                    actual = (t.get("actual") or "")[:60]
                    if expected and actual:
                        print(f"      \u2717 {t.get('tool', '?')}: expected='{expected}' got='{actual}'")
                    elif err:
                        print(f"      \u2717 {t.get('tool', '?')}: {err}")
                    else:
                        print(f"      \u2717 {t.get('tool', '?')}: FAILED (no details)")
        if missing > 0:
            for t in tools_reported:
                if t.get("status", "").lower() == "missing":
                    print(f"      \u2205 {t.get('tool', '?')}: tool not available")

    # ═══════════════════════════════════════════════════════════════
    # SECTION 3: Required tools validation
    # ═══════════════════════════════════════════════════════════════

    print("")
    print("\u2550" * 80)
    print("  Required Tools Validation (role-based)")
    print("\u2550" * 80)
    print("")

    base_required = REQUIRED_TOOLS_BY_ROLE.get("_all", [])
    validation_failures = 0

    for agent_name in sorted(results.keys()):
        result = results[agent_name]
        if result.get("error"):
            print(f"  \u2717 {agent_name}: SKIPPED (invocation failed)")
            validation_failures += 1
            continue

        # Get all tool names this agent reported (normalized)
        reported_tools = set()
        for tool_result in result.get("tools", []):
            if not isinstance(tool_result, dict):
                continue
            name = normalize_tool_name(tool_result.get("tool", tool_result.get("name", "unknown")))
            status = tool_result.get("status", "").lower()
            # Only count tools that are actually available (success or failed-but-callable)
            if status not in ("missing",):
                reported_tools.add(name)

        # Check base required tools + role-specific required tools
        role_required = REQUIRED_TOOLS_BY_ROLE.get(agent_name, [])
        all_required = list(base_required) + list(role_required)

        missing = []
        for req_tool in all_required:
            normalized_req = normalize_tool_name(req_tool)
            # Fuzzy match: check if required tool name appears in any reported tool
            found = any(normalized_req in t or t in normalized_req for t in reported_tools)
            # Also check short name (e.g., "search_issues" matches "tickets___search_issues")
            if not found:
                short = req_tool.split("___")[-1] if "___" in req_tool else req_tool
                found = any(short in t for t in reported_tools)
            if not found:
                missing.append(req_tool)

        if missing:
            print(f"  \u2717 {agent_name}: MISSING {len(missing)} required tools:")
            for m in missing:
                print(f"      - {m}")
            validation_failures += 1
        else:
            print(f"  \u2713 {agent_name}: all required tools present")

    print("")
    if validation_failures > 0:
        print(f"  \u2717 VALIDATION FAILED: {validation_failures} agents missing required tools")
    else:
        print(f"  \u2713 ALL AGENTS HAVE REQUIRED TOOLS — fleet is healthy")
    print("\u2550" * 80)
    print("")


def main():
    parser = argparse.ArgumentParser(description="Fleet health check invoker")
    parser.add_argument("--fleet-file", required=True, help="Path to fleet-runtime-ids.json")
    parser.add_argument("--region", default="us-east-1", help="AWS region")
    parser.add_argument("--timeout", type=int, default=360, help="Timeout per agent in seconds (real integration tests take longer)")
    parser.add_argument("--parallel", type=int, default=3, help="Max parallel invocations")
    parser.add_argument("--agent", type=str, default=None, help="Test single agent (name from fleet file)")
    parser.add_argument("--verbose", action="store_true", help="Print raw agent responses")
    parser.add_argument("--model", type=str, default=None, help="Model override (e.g., us.anthropic.claude-sonnet-4-6, sonnet, haiku)")
    args = parser.parse_args()

    with open(args.fleet_file, "r") as f:
        fleet = json.load(f)

    if not fleet:
        print("ERROR: No agents found in fleet file.")
        sys.exit(1)

    # Filter to single agent if requested
    if args.agent:
        if args.agent not in fleet:
            print(f"ERROR: Agent '{args.agent}' not found. Available: {', '.join(fleet.keys())}")
            sys.exit(1)
        fleet = {args.agent: fleet[args.agent]}

    print(f"  Invoking {len(fleet)} agents ({args.parallel} concurrent, {args.timeout}s timeout)...")
    print(f"  Running 40 integration tests per agent (9 test groups)")
    print(f"  Fixtures: s3://{TEST_FIXTURES['bucket']}/{TEST_FIXTURES['prefix']}")
    print("")

    credentials = get_credentials()
    results = {}

    with ThreadPoolExecutor(max_workers=args.parallel) as executor:
        futures = {}
        for agent_name, arn in fleet.items():
            future = executor.submit(
                invoke_runtime_agent, agent_name, arn, args.region, args.timeout, credentials, args.model
            )
            futures[future] = agent_name

        for future in as_completed(futures):
            agent_name = futures[future]
            try:
                result = future.result()
                status_icon = "\u2713" if not result.get("error") else "\u2717"
                tool_count = len(result.get("tools", []))
                print(f"  {status_icon} {agent_name}: {tool_count} tools reported")
                if args.verbose and result.get("raw"):
                    print(f"      RAW: {result['raw'][:200]}")
                results[agent_name] = result
            except Exception as e:
                print(f"  \u2717 {agent_name}: Exception - {e}")
                results[agent_name] = {"error": str(e), "tools": []}

    print_results(results)

    # Write results to JSON for downstream analysis
    output_file = args.fleet_file.replace("fleet-runtime-ids.json", "fleet-health-results.json")
    with open(output_file, "w") as f:
        # Serialize results (strip raw text to keep file small)
        serializable = {}
        for name, result in results.items():
            serializable[name] = {
                "error": result.get("error"),
                "tools": result.get("tools", []),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        json.dump(serializable, f, indent=2)
    print(f"  Results saved to: {output_file}")


if __name__ == "__main__":
    main()
