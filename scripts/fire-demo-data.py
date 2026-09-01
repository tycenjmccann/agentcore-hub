#!/usr/bin/env python3
"""Fire 10 demo workflows to populate the hub with data.

Features -> POST /api/workflow/start (App Runner).
Bugs     -> create top-level Jira Bug via REST; orchestrator webhook bootstraps.

Order: F,B,F,B,B,F,F,B,F,F  (6 features, 4 bugs), alternating/mixed.
Repo:  tycenjmccann/tic-tac-toe-ai
"""
import base64
import json
import sys
import time
import urllib.request

APP = "https://s4nmap2prm.us-east-1.awsapprunner.com"
REPO = "https://github.com/tycenjmccann/tic-tac-toe-ai"
BRANCH = "main"

# ── load .env.local ──────────────────────────────────────────────
env = {}
for line in open("/Users/tycenj/Desktop/agentcore-hub-fresh/.env.local"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k] = v.strip().strip('"').strip("'")

JIRA_SITE = env["JIRA_SITE_URL"]
JIRA_EMAIL = env["JIRA_EMAIL"]
JIRA_TOKEN = env["JIRA_API_TOKEN"]
JIRA_PROJECT = env.get("JIRA_PROJECT_KEY", "TEAM")
JIRA_AUTH = "Basic " + base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()


def adf(text):
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph",
             "content": [{"type": "text", "text": line}] if line else []}
            for line in text.split("\n")
        ],
    }


def post(url, body, headers):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def fire_feature(title, desc):
    body = {
        "title": title,
        "description": desc,
        "sources": [],
        "repoConfig": {"layout": "monorepo",
                       "repos": [{"url": REPO, "defaultBranch": BRANCH, "platform": "shared"}]},
        "workflowType": "feature",
    }
    s, j = post(f"{APP}/api/workflow/start", body,
                {"Content-Type": "application/json"})
    return f"FEATURE [{s}] {j.get('workflowId','?')} epic={j.get('epicId','?')}"


def fire_bug(title, desc):
    body = {
        "fields": {
            "project": {"key": JIRA_PROJECT},
            "summary": title,
            "description": adf(desc + f"\n\nTarget repo: {REPO}"),
            "issuetype": {"name": "Bug"},
            "labels": ["agentcore-hub-workflow", "demo-data"],
        }
    }
    s, j = post(f"https://{JIRA_SITE}/rest/api/3/issue", body,
                {"Authorization": JIRA_AUTH, "Content-Type": "application/json",
                 "Accept": "application/json"})
    return f"BUG     [{s}] {j.get('key','?')}"


# title, description
FEATURES = [
    ("Add round score tracking",
     "Track wins, losses, and draws across multiple rounds and display a running scoreboard above the board."),
    ("Add light/dark theme toggle",
     "Add a theme toggle button that switches the board and UI between light and dark color schemes, persisted in localStorage."),
    ("Add undo last move",
     "Add an Undo button that reverts the most recent move (both player and AI) and restores the prior board state."),
    ("Add keyboard navigation",
     "Allow playing the entire game with arrow keys + Enter for accessibility, including focus outlines on cells."),
    ("Add win-streak celebration",
     "When a player wins 3+ rounds in a row, show a confetti celebration animation and a streak counter."),
    ("Add adjustable AI difficulty",
     "Add Easy / Medium / Hard difficulty settings that change the AI move-selection strategy."),
]
BUGS = [
    ("AI skips its turn after a draw",
     "After a drawn game, starting a new round occasionally leaves the AI idle so the player can take two turns in a row."),
    ("Win highlight not cleared on new game",
     "The highlighted winning line from the previous game persists when a new game starts until the first move is made."),
    ("Reset leaves stale board state",
     "Clicking Reset clears the visual board but the internal game state still records old moves, causing invalid win detection."),
    ("Wrong winner on diagonal win",
     "A diagonal three-in-a-row is sometimes attributed to the wrong player in the result banner."),
]

# F,B,F,B,B,F,F,B,F,F
PLAN = [
    ("F", 0), ("B", 0), ("F", 1), ("B", 1), ("B", 2),
    ("F", 2), ("F", 3), ("B", 3), ("F", 4), ("F", 5),
]

if __name__ == "__main__":
    for i, (kind, idx) in enumerate(PLAN, 1):
        try:
            if kind == "F":
                out = fire_feature(*FEATURES[idx])
            else:
                out = fire_bug(*BUGS[idx])
            print(f"{i:2}. {out}")
        except Exception as e:
            print(f"{i:2}. {kind} ERROR: {e}")
        sys.stdout.flush()
        time.sleep(8)  # stagger so the pipeline isn't slammed at once
