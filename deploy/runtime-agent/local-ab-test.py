"""
Local A/B Test Runner — Run two agent variants against the same task, compare PRs.

Both agents:
  1. Clone the real repo
  2. Create a unique branch
  3. Do the actual work (write code, tests, etc.)
  4. Commit, push, create a PR
  5. Output their PR URL for comparison

Usage:
  python local-ab-test.py --repo <github-repo-url> --task "Add feature X"

  # Or use defaults (sample task against configured repo):
  python local-ab-test.py

Environment:
  - AWS credentials (for Bedrock model access + Lambda tools)
  - GITHUB_PAT (for push + PR creation via MCP)
  - Runs in /tmp/ab-test-* directories (clean workspace per agent)

Requirements:
  pip install strands-agents strands-agents-tools boto3
"""

import os
import sys
import json
import time
import argparse
import uuid
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Ensure tools run non-interactively
os.environ["BYPASS_TOOL_CONSENT"] = "true"

import boto3
from strands import Agent
from strands.models import BedrockModel
from botocore.config import Config as BotocoreConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("ab-test")

# ─── Configuration ───────────────────────────────────────────────────────────

REGION = os.getenv("AWS_REGION", "us-east-1")
DEFAULT_REPO = "https://github.com/your-org/your-repo.git"
DEFAULT_TASK = """
Implement a /health endpoint in the Next.js API that returns:
- { status: "ok", timestamp: <ISO string>, version: <from package.json> }
- Add a simple unit test for it using vitest or jest (whichever the project uses)
- The endpoint should be at src/app/api/health/route.ts
"""

SCRIPT_DIR = Path(__file__).parent
PROMPTS_DIR = SCRIPT_DIR / "prompts"

# Load .env.local for GITHUB_PAT if not already set
ENV_FILE = SCRIPT_DIR.parent.parent / ".env.local"
if ENV_FILE.exists() and not os.getenv("GITHUB_PAT"):
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("GITHUB_PAT="):
            os.environ["GITHUB_PAT"] = line.split("=", 1)[1].strip().strip('"')


# ─── Variant Definitions ─────────────────────────────────────────────────────

VARIANTS = {
    "A": {
        "name": "Opus (direct coding)",
        "model_id": "us.anthropic.claude-opus-5",
        "prompt_file": "agentcore_hub_frontend_dev.txt",
        "extra_instructions": "",
        "use_claude_code": False,
    },
    "B": {
        "name": "Opus (Claude Code SDK)",
        "model_id": "us.anthropic.claude-opus-5",
        "prompt_file": "agentcore_hub_frontend_dev.txt",
        "extra_instructions": """You have access to a `claude_code` tool that delegates coding tasks to Claude Code —
a specialized coding agent with its own file editing, terminal, and git capabilities running in an isolated environment.

STRATEGY: Use claude_code for ALL implementation work:
- Cloning repos, creating branches
- Reading existing code to understand structure
- Writing/editing source files
- Running tests and fixing failures
- Git commits and pushes

You handle the high-level orchestration (understanding requirements, deciding what to build,
verifying the PR was created), but delegate ALL file manipulation and coding to claude_code.

Example: claude_code(task="Clone https://github.com/org/repo, checkout -b my-branch, then implement a /health endpoint in src/app/api/health/route.ts that returns {status:'ok', timestamp, version}. Write a test. Commit and push.")
""",
        "use_claude_code": True,
    },
}


# ─── Claude Code SDK Tool ────────────────────────────────────────────────────

from strands import tool

@tool
def claude_code(task: str, working_directory: str = "/tmp") -> str:
    """Delegate a coding task to Claude Code — a specialized coding agent.

    Claude Code can clone repos, read/write files, run shell commands, run tests,
    git commit, git push, and create PRs. It operates in its own environment.

    Use this for ALL implementation work: cloning, coding, testing, committing.

    Args:
        task: Complete description of what Claude Code should do. Be specific —
              include repo URLs, branch names, file paths, and expected outcomes.
        working_directory: Directory where Claude Code should operate (default: /tmp)
    """
    import subprocess

    logger.info(f"[claude_code] Invoking with task: {task[:100]}...")

    try:
        # Claude Code SDK CLI invocation — runs claude as a subprocess
        # Uses the `claude` CLI with --print flag for non-interactive mode
        result = subprocess.run(
            [
                "claude",
                "--print",              # non-interactive, outputs result
                "--output-format", "text",
                "--max-turns", "50",    # allow complex multi-step tasks
                task,
            ],
            cwd=working_directory,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minute max
            env={**os.environ, "CLAUDE_CODE_ENTRYPOINT": "ab-test"},
        )

        output = result.stdout.strip()
        if result.returncode != 0 and result.stderr:
            output += f"\n\nSTDERR: {result.stderr[-500:]}"

        logger.info(f"[claude_code] Complete. Output: {len(output)} chars, exit code: {result.returncode}")
        return output if output else f"Claude Code exited with code {result.returncode}. Stderr: {result.stderr[-300:]}"

    except subprocess.TimeoutExpired:
        return "ERROR: Claude Code timed out after 600 seconds"
    except FileNotFoundError:
        return "ERROR: 'claude' CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    except Exception as e:
        return f"ERROR: {str(e)}"


# ─── Tool Loading ────────────────────────────────────────────────────────────

def load_tools(include_claude_code: bool = False):
    """Load all built-in strands tools (same as deployed agents get)."""
    from strands_tools import (
        image_reader, http_request, current_time, calculator,
        file_read, file_write, editor, shell, environment,
        python_repl, retrieve,
    )
    tools = [
        image_reader, http_request, current_time, calculator,
        file_read, file_write, editor, shell, environment,
        python_repl, retrieve,
    ]

    # Claude Code SDK tool (only for variant B)
    if include_claude_code:
        tools.append(claude_code)
        logger.info("Claude Code SDK tool attached")

    # GitHub MCP (for PR creation)
    github_pat = os.getenv("GITHUB_PAT", "")
    if github_pat:
        try:
            from strands.tools.mcp import MCPClient
            from mcp.client.streamable_http import streamablehttp_client

            mcp_client = MCPClient(
                lambda: streamablehttp_client(
                    url="https://api.githubcopilot.com/mcp/",
                    headers={"Authorization": f"Bearer {github_pat}"},
                    timeout=60,
                )
            )
            tools.append(mcp_client)
            logger.info("GitHub MCP client attached")
        except Exception as e:
            logger.warning(f"Failed to create GitHub MCP client: {e}")
    else:
        logger.warning("No GITHUB_PAT — agent won't be able to push/PR")

    return tools


# ─── Agent Runner ────────────────────────────────────────────────────────────

def run_variant(
    variant_key: str,
    variant_config: dict,
    repo_url: str,
    task: str,
    run_id: str,
) -> dict:
    """Run a single variant agent end-to-end. Returns result dict."""
    variant_name = variant_config["name"]
    model_id = variant_config["model_id"]
    prompt_file = variant_config["prompt_file"]
    extra = variant_config.get("extra_instructions", "")
    use_claude_code = variant_config.get("use_claude_code", False)

    logger.info(f"[Variant {variant_key}] Starting: {variant_name} ({model_id})")

    # Create isolated workspace
    workspace = f"/tmp/ab-test-{run_id}-{variant_key.lower()}"
    os.makedirs(workspace, exist_ok=True)

    # Branch name unique to this test run
    branch_name = f"ab-test/{run_id}-variant-{variant_key.lower()}"

    # Load system prompt
    system_prompt = (PROMPTS_DIR / prompt_file).read_text()
    if extra:
        system_prompt += f"\n\n## ADDITIONAL INSTRUCTIONS\n{extra}"

    # Build task prompt with workspace context
    full_prompt = f"""## YOUR TASK

You are running as Variant {variant_key} in a local A/B test.

**Repo:** {repo_url}
**Branch to create:** {branch_name}
**Workspace directory:** {workspace}

### Instructions:
1. `cd {workspace}` then clone the repo: `git clone {repo_url} project && cd project`
2. Create and checkout branch: `git checkout -b {branch_name}`
3. Do the work described below
4. Commit your changes with a clear message
5. Push the branch: `git push origin {branch_name}`
6. Create a Pull Request using the GitHub MCP tools (title should mention "Variant {variant_key}")
7. Output the PR URL as your final response

### Task:
{task}

### Rules:
- Work ONLY in {workspace}/project/
- Do NOT modify main branch
- Commit real, working code
- Include at least one test
- Create the PR — that's how we measure success
"""

    # Create model
    boto_config = BotocoreConfig(
        read_timeout=600,
        connect_timeout=30,
        retries={"max_attempts": 2},
    )
    model = BedrockModel(
        model_id=model_id,
        region_name=REGION,
        boto_client_config=boto_config,
        streaming=True,
    )

    # Load tools (variant B gets claude_code tool)
    tools = load_tools(include_claude_code=use_claude_code)

    # Track tool usage
    tool_calls = []

    class ToolTracker:
        def __init__(self):
            self.prev = None

        def __call__(self, **kwargs):
            current = kwargs.get("current_tool_use", {})
            if current and current.get("name") and current != self.prev:
                self.prev = current
                tool_calls.append(current["name"])
                logger.info(f"  [Variant {variant_key}] Tool: {current['name']}")

    # Create and invoke agent
    agent = Agent(
        model=model,
        system_prompt=system_prompt,
        tools=tools,
        callback_handler=ToolTracker(),
    )

    start_time = time.time()
    try:
        result = agent(full_prompt)
        # Extract text
        final_text = ""
        if hasattr(result, "message") and result.message:
            msg = result.message
            content = msg.get("content", []) if isinstance(msg, dict) else getattr(msg, "content", [])
            for block in (content or []):
                if isinstance(block, dict) and "text" in block:
                    final_text += block["text"]

        elapsed = time.time() - start_time
        logger.info(f"[Variant {variant_key}] Complete in {elapsed:.1f}s, {len(tool_calls)} tool calls")

        return {
            "variant": variant_key,
            "name": variant_name,
            "model": model_id,
            "branch": branch_name,
            "output": final_text,
            "tool_calls": tool_calls,
            "tool_count": len(tool_calls),
            "elapsed_seconds": round(elapsed, 1),
            "success": True,
            "error": None,
        }

    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"[Variant {variant_key}] FAILED after {elapsed:.1f}s: {e}")
        return {
            "variant": variant_key,
            "name": variant_name,
            "model": model_id,
            "branch": branch_name,
            "output": "",
            "tool_calls": tool_calls,
            "tool_count": len(tool_calls),
            "elapsed_seconds": round(elapsed, 1),
            "success": False,
            "error": str(e),
        }


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Local A/B test for agent variants")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Git repo URL to clone")
    parser.add_argument("--task", default=DEFAULT_TASK, help="Task description for agents")
    parser.add_argument("--parallel", action="store_true", help="Run both variants in parallel")
    parser.add_argument("--variant", choices=["A", "B"], help="Run only one variant (for debugging)")
    parser.add_argument("--model-a", help="Override model for variant A")
    parser.add_argument("--model-b", help="Override model for variant B")
    parser.add_argument("--prompt-a", help="Override prompt file for variant A")
    parser.add_argument("--prompt-b", help="Override prompt file for variant B")
    parser.add_argument("--extra-a", help="Extra instructions appended to variant A prompt")
    parser.add_argument("--extra-b", help="Extra instructions appended to variant B prompt")
    args = parser.parse_args()

    # Apply overrides
    if args.model_a:
        VARIANTS["A"]["model_id"] = args.model_a
    if args.model_b:
        VARIANTS["B"]["model_id"] = args.model_b
    if args.prompt_a:
        VARIANTS["A"]["prompt_file"] = args.prompt_a
    if args.prompt_b:
        VARIANTS["B"]["prompt_file"] = args.prompt_b
    if args.extra_a:
        VARIANTS["A"]["extra_instructions"] = args.extra_a
    if args.extra_b:
        VARIANTS["B"]["extra_instructions"] = args.extra_b

    run_id = uuid.uuid4().hex[:8]
    logger.info(f"═══ A/B Test Run: {run_id} ═══")
    logger.info(f"Repo: {args.repo}")
    logger.info(f"Task: {args.task.strip()[:100]}...")
    logger.info(f"Variant A: {VARIANTS['A']['name']} ({VARIANTS['A']['model_id']})")
    logger.info(f"Variant B: {VARIANTS['B']['name']} ({VARIANTS['B']['model_id']})")
    logger.info("")

    # Determine which variants to run
    variants_to_run = {}
    if args.variant:
        variants_to_run[args.variant] = VARIANTS[args.variant]
    else:
        variants_to_run = VARIANTS

    results = []

    if args.parallel and len(variants_to_run) > 1:
        logger.info("Running variants in PARALLEL...")
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {
                pool.submit(run_variant, k, v, args.repo, args.task, run_id): k
                for k, v in variants_to_run.items()
            }
            for future in as_completed(futures):
                results.append(future.result())
    else:
        logger.info("Running variants SEQUENTIALLY...")
        for key, config in variants_to_run.items():
            result = run_variant(key, config, args.repo, args.task, run_id)
            results.append(result)

    # ─── Results Summary ─────────────────────────────────────────────────────
    print("\n")
    print("═" * 70)
    print(f"  A/B TEST RESULTS — Run {run_id}")
    print("═" * 70)

    for r in sorted(results, key=lambda x: x["variant"]):
        status = "✅ SUCCESS" if r["success"] else "❌ FAILED"
        print(f"\n  Variant {r['variant']}: {r['name']}")
        print(f"  {'─' * 50}")
        print(f"  Status:     {status}")
        print(f"  Model:      {r['model']}")
        print(f"  Branch:     {r['branch']}")
        print(f"  Duration:   {r['elapsed_seconds']}s")
        print(f"  Tool Calls: {r['tool_count']}")
        if r["error"]:
            print(f"  Error:      {r['error'][:200]}")
        if r["output"]:
            # Try to extract PR URL from output
            pr_url = ""
            for line in r["output"].split("\n"):
                if "github.com" in line and "/pull/" in line:
                    pr_url = line.strip()
                    break
            if pr_url:
                print(f"  PR URL:     {pr_url}")
            else:
                print(f"  Output:     {r['output'][:300]}...")

    print(f"\n{'═' * 70}")

    # Save full results to JSON
    results_file = f"/tmp/ab-test-{run_id}-results.json"
    with open(results_file, "w") as f:
        json.dump({
            "run_id": run_id,
            "repo": args.repo,
            "task": args.task,
            "variants": VARIANTS,
            "results": results,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, f, indent=2)
    print(f"\n  Full results saved to: {results_file}")
    print("")


if __name__ == "__main__":
    main()
