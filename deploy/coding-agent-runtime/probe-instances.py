#!/usr/bin/env python3
"""
probe-instances.py — measure the Instances coding runtime before routing real work
to it. Every number the go/no-go depends on, from the outside, with no UI:

  cold      N fresh sessions in parallel → healthcheck; time to first response
            (= EC2 provisioning + container start + /ping) → p50 / p95
  pin       10 sequential commands on ONE session → instance-id each time; the
            plan is dead unless they are all the same instance
  fs        dd + 2,000 small files on the EBS workspace and on the root disk
  turn      one real Claude Code turn: clone the hub, npm ci, tsc, one vitest file;
            the CLI reports the wall of each step
  persist   stop-runtime-session → healthcheck (re-provision time) → the marker
            file and node_modules from `turn` must still be on /mnt/workspace
  cleanup   delete every session this script created (instance + volume), then
            prove no managed instance is left

State (session ids, timings) is kept in .local-workspace/analysis/instances-spike/
so phases can run in separate invocations:

  P=/tmp/ac-venv/bin/python; export AWS_PROFILE=tycenj-prod
  $P probe-instances.py cold --n 5
  $P probe-instances.py pin
  $P probe-instances.py fs
  $P probe-instances.py turn --repo tycenjmccann/agentcore-hub
  $P probe-instances.py persist
  $P probe-instances.py cleanup

Reads the runtime ARN from coding-runtime-instances-arn.txt (or CODING_AGENT_RUNTIME_ARN_INSTANCES)
and the capacity provider id from the runtime's config.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
STATE_DIR = REPO_ROOT / ".local-workspace" / "analysis" / "instances-spike"
STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE = STATE_DIR / "state.json"
MOUNT = "/mnt/workspace"

data = boto3.client("bedrock-agentcore", region_name=REGION,
                    config=Config(read_timeout=930, connect_timeout=30, retries={"max_attempts": 0}))
control = boto3.client("bedrock-agentcore-control", region_name=REGION)
ec2 = boto3.client("ec2", region_name=REGION)


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"sessions": {}, "results": {}}


def save_state(st: dict) -> None:
    STATE.write_text(json.dumps(st, indent=2, default=str))


def runtime_arn() -> str:
    arn = os.environ.get("CODING_AGENT_RUNTIME_ARN_INSTANCES")
    if not arn:
        f = HERE / "coding-runtime-instances-arn.txt"
        if not f.exists():
            sys.exit("no runtime ARN: run deploy-instances.py first or set CODING_AGENT_RUNTIME_ARN_INSTANCES")
        arn = f.read_text().strip()
    return arn


def capacity_provider_id(arn: str) -> str:
    rt_id = arn.rsplit("/", 1)[-1]
    rt = control.get_agent_runtime(agentRuntimeId=rt_id)
    cp_arn = rt["capacityProviderConfiguration"]["capacityProviderArn"]
    return cp_arn.rsplit("/", 1)[-1]


def new_session(tag: str) -> str:
    return f"spike-{tag}-{uuid.uuid4().hex}"  # ≥ 33 chars


def invoke(arn: str, session: str, payload: dict, label: str = "") -> tuple[float, int, str]:
    t0 = time.time()
    try:
        resp = data.invoke_agent_runtime(agentRuntimeArn=arn, runtimeSessionId=session,
                                         payload=json.dumps(payload).encode(), contentType="application/json",
                                         accept="application/json")
        body = resp["response"].read().decode(errors="replace") if hasattr(resp["response"], "read") \
            else "".join(c.decode(errors="replace") if isinstance(c, bytes) else str(c) for c in resp["response"])
        return time.time() - t0, resp["ResponseMetadata"]["HTTPStatusCode"], body
    except ClientError as exc:
        return time.time() - t0, exc.response["ResponseMetadata"].get("HTTPStatusCode", 0), json.dumps(exc.response["Error"])


def command(arn: str, session: str, cmd: str, timeout: int = 300) -> dict:
    t0 = time.time()
    out, err, code, status = [], [], None, None
    try:
        resp = data.invoke_agent_runtime_command(agentRuntimeArn=arn, runtimeSessionId=session,
                                                 body={"command": cmd, "timeout": timeout})
        for ev in resp["stream"]:
            if "chunk" in ev:
                ch = ev["chunk"]
                if "contentDelta" in ch:
                    out.append(ch["contentDelta"].get("stdout") or "")
                    err.append(ch["contentDelta"].get("stderr") or "")
                if "contentStop" in ch:
                    code = ch["contentStop"].get("exitCode")
                    status = ch["contentStop"].get("status")
            else:
                key = next(iter(ev))
                return {"latency": time.time() - t0, "error": key, "message": ev[key].get("message")}
    except ClientError as exc:
        return {"latency": time.time() - t0, "error": exc.response["Error"]["Code"],
                "message": exc.response["Error"].get("Message")}
    return {"latency": time.time() - t0, "exit": code, "status": status,
            "stdout": "".join(out).strip(), "stderr": "".join(err).strip()}


IDENT_CMD = (
    "TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); "
    "IID=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-id); "
    "ITYPE=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-type); "
    "echo \"instance=${IID:-unknown} type=${ITYPE:-unknown} host=$(hostname) nproc=$(nproc) "
    "mem_gb=$(awk '/MemTotal/{printf \"%d\", $2/1048576}' /proc/meminfo) "
    "ws=$(df -BG --output=size,avail " + MOUNT + " | tail -1 | tr -s ' ') root=$(df -BG --output=size,avail / | tail -1 | tr -s ' ') "
    "nofile=$(ulimit -Hn) uptime_s=$(cut -d. -f1 /proc/uptime)\""
)


# ─── phases ──────────────────────────────────────────────────────────────────

def phase_cold(arn: str, n: int, st: dict) -> None:
    print(f"▶ cold: {n} fresh sessions in parallel (healthcheck payload)")

    def one(i: int):
        sid = new_session(f"cold{i}")
        lat, code, body = invoke(arn, sid, {"healthcheck": True})
        ok = code == 200 and '"ok": true' in body.replace(" ", "").lower().replace('"ok":true', '"ok": true')
        return sid, lat, code, body[:300]

    with ThreadPoolExecutor(max_workers=n) as ex:
        results = list(ex.map(one, range(n)))
    lats = []
    for sid, lat, code, body in results:
        st["sessions"][sid] = {"phase": "cold", "created": time.time()}
        lats.append(lat)
        print(f"   {sid[:24]}…  {lat:6.1f} s  HTTP {code}  {body[:120]!r}")
        # second call on the same, now-running instance = warm latency
    warm = []
    for sid, *_ in results[:3]:
        lat, code, body = invoke(arn, sid, {"healthcheck": True})
        warm.append(lat)
        print(f"   warm {sid[:24]}…  {lat:6.1f} s  HTTP {code}")
    lats_sorted = sorted(lats)
    p50 = statistics.median(lats_sorted)
    p95 = lats_sorted[min(len(lats_sorted) - 1, int(round(0.95 * (len(lats_sorted) - 1))))]
    st["results"]["cold"] = {"n": n, "latencies_s": lats, "p50_s": p50, "p95_s": p95,
                             "max_s": max(lats), "warm_s": warm, "at": time.time()}
    print(f"   cold p50 {p50:.1f} s  p95 {p95:.1f} s  max {max(lats):.1f} s   warm {[round(w, 2) for w in warm]}")


def pick_session(st: dict, prefer: str | None = None) -> str:
    if prefer and prefer in st["sessions"]:
        return prefer
    for sid, meta in st["sessions"].items():
        if meta.get("phase") in ("cold", "turn") and not meta.get("deleted"):
            return sid
    sys.exit("no live session in state — run `cold` first")


def phase_pin(arn: str, st: dict, session: str | None) -> None:
    sid = pick_session(st, session)
    print(f"▶ pin: 10 sequential identity commands on {sid[:30]}…")
    ids, lats = [], []
    for i in range(10):
        r = command(arn, sid, IDENT_CMD, timeout=60)
        lats.append(r["latency"])
        line = r.get("stdout") or f"{r.get('error')}: {r.get('message')}"
        ids.append(line.split()[0] if line.startswith("instance=") else line[:60])
        print(f"   #{i + 1:2d} {r['latency']:5.2f} s  {line[:150]}")
    pinned = len(set(ids)) == 1 and ids[0].startswith("instance=")
    st["results"]["pin"] = {"session": sid, "instances": ids, "pinned": pinned,
                            "cmd_latency_s": lats, "at": time.time()}
    print(f"   pinned={pinned}  cmd p50 {statistics.median(lats):.2f} s")


FS_CMD = r"""
set -e
probe() {
  d="$1"; mkdir -p "$d/.fsprobe"; cd "$d/.fsprobe"
  s=$(date +%s.%N); dd if=/dev/zero of=bulk bs=1M count=1024 conv=fsync status=none; e=$(date +%s.%N)
  bulk=$(awk "BEGIN{printf \"%.3f\", $e - $s}")
  s=$(date +%s.%N); for i in $(seq 1 2000); do echo x > f$i; done; sync; e=$(date +%s.%N)
  small=$(awk "BEGIN{printf \"%.3f\", $e - $s}")
  s=$(date +%s.%N); rm -rf "$d/.fsprobe"; e=$(date +%s.%N)
  rmt=$(awk "BEGIN{printf \"%.3f\", $e - $s}")
  echo "$d bulk_1GiB_s=$bulk small_2000_s=$small rm_s=$rmt"
}
# The volume root is nobody:agentcore-runtime-user and the command shell lacks that
# group; main.py (which carries it) creates sessions/ owned by our uid, so probe there.
probe MOUNT/sessions
probe /tmp
findmnt -no SOURCE,FSTYPE,OPTIONS MOUNT || true
""".replace("MOUNT", MOUNT)


def phase_fs(arn: str, st: dict, session: str | None) -> None:
    sid = pick_session(st, session)
    print(f"▶ fs: dd + small files on {MOUNT} and /tmp ({sid[:30]}…)")
    r = command(arn, sid, FS_CMD, timeout=600)
    print("   " + (r.get("stdout") or "").replace("\n", "\n   "))
    if r.get("stderr"):
        print("   stderr: " + r["stderr"][:300])
    st["results"]["fs"] = {"session": sid, **r, "at": time.time()}


TURN_PROMPT = """You are on a fresh machine. In the repo checkout (your cwd), run these exactly, timing each with `/usr/bin/time -f '%e s'` or `date +%s.%N` deltas, and do NOT fix anything that fails:
1. `npm ci --no-audit --no-fund`
2. `npx tsc --noEmit`
3. `npx vitest run src/lib/cd-registry.test.ts`
4. `du -sh node_modules && df -h . | tail -1 && nproc`
Then `echo spike-marker-$(date +%s) > .spike-marker`.
Reply with ONLY a compact table: step | wall seconds | exit code, followed by the du/df/nproc line. No commentary."""


def phase_turn(arn: str, st: dict, repo: str, session: str | None) -> None:
    sid = session or new_session("turn")
    st["sessions"].setdefault(sid, {"phase": "turn", "created": time.time()})
    print(f"▶ turn: real Claude Code turn on {sid[:30]}… repo {repo} (sync invoke, ≤15 min)")
    lat, code, body = invoke(arn, sid, {"prompt": TURN_PROMPT, "cli": "claude", "repo": repo,
                                        "permission_mode": "bypassPermissions", "model": "sonnet"})
    print(f"   {lat:.0f} s  HTTP {code}")
    text = body
    try:
        obj = json.loads(body)
        text = obj.get("response") or obj.get("result") or body
        if obj.get("claude_session_id"):
            st["sessions"][sid]["claude_session_id"] = obj["claude_session_id"]
    except json.JSONDecodeError:
        pass
    print("   " + str(text)[:1500].replace("\n", "\n   "))
    st["results"]["turn"] = {"session": sid, "repo": repo, "wall_s": lat, "http": code,
                             "response": str(text)[:4000], "at": time.time()}


def phase_persist(arn: str, st: dict, session: str | None) -> None:
    sid = session or (st["results"].get("turn") or {}).get("session") or pick_session(st)
    slug_cmd = f"ls -d {MOUNT}/sessions/*/* 2>/dev/null | head -3; find {MOUNT} -maxdepth 4 -name .spike-marker -exec cat {{}} \\; 2>/dev/null; " \
               f"find {MOUNT} -maxdepth 4 -type d -name node_modules -exec sh -c 'echo {{}}: $(ls {{}} | wc -l) pkgs' \\; 2>/dev/null | head -3"
    before = command(arn, sid, slug_cmd, timeout=120)
    print(f"▶ persist: before stop → {before.get('stdout', before)[:300]!r}")
    t0 = time.time()
    data.stop_runtime_session(agentRuntimeArn=arn, runtimeSessionId=sid)
    print(f"   stop-runtime-session issued ({time.time() - t0:.1f} s); waiting 20 s")
    time.sleep(20)
    lat, code, body = invoke(arn, sid, {"healthcheck": True})
    print(f"   re-provision + healthcheck: {lat:.1f} s  HTTP {code}")
    after = command(arn, sid, slug_cmd, timeout=120)
    print(f"   after resume → {after.get('stdout', after)[:300]!r}")
    ident = command(arn, sid, IDENT_CMD, timeout=60)
    print(f"   {ident.get('stdout', ident)[:200]}")
    intact = bool(before.get("stdout")) and before.get("stdout") == after.get("stdout")
    st["results"]["persist"] = {"session": sid, "reprovision_s": lat, "http": code, "intact": intact,
                                "before": before.get("stdout"), "after": after.get("stdout"),
                                "identity_after": ident.get("stdout"), "at": time.time()}
    print(f"   intact={intact}")


def phase_cleanup(arn: str, st: dict) -> None:
    cp_id = capacity_provider_id(arn)
    print(f"▶ cleanup: delete-capacity-provider-session for every recorded session (cp {cp_id})")
    for sid, meta in st["sessions"].items():
        if meta.get("deleted"):
            continue
        try:
            data.delete_capacity_provider_session(capacityProviderId=cp_id, sessionId=sid)
            meta["deleted"] = time.time()
            print(f"   ✓ {sid[:30]}…")
        except ClientError as exc:
            print(f"   ✗ {sid[:30]}… {exc.response['Error']['Code']}: {exc.response['Error'].get('Message')}")
    time.sleep(30)
    left = ec2.describe_instances(
        IncludeManagedResources=True,
        Filters=[{"Name": "tag-key", "Values": ["bedrock-agentcore:capacity-provider-id"]},
                 {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}],
    )
    inst = [(i["InstanceId"], i["State"]["Name"]) for r in left["Reservations"] for i in r["Instances"]]
    vols = ec2.describe_volumes(Filters=[{"Name": "tag-key", "Values": ["bedrock-agentcore:capacity-provider-id"]}])["Volumes"]
    st["results"]["cleanup"] = {"instances_left": inst, "volumes_left": len(vols), "at": time.time()}
    print(f"   managed instances left: {inst or 'none'}; tagged volumes left: {len(vols)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["cold", "pin", "fs", "turn", "persist", "cleanup", "show"])
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--session")
    ap.add_argument("--repo", default="tycenjmccann/agentcore-hub")
    args = ap.parse_args()
    arn = runtime_arn()
    st = load_state()
    try:
        if args.phase == "cold":
            phase_cold(arn, args.n, st)
        elif args.phase == "pin":
            phase_pin(arn, st, args.session)
        elif args.phase == "fs":
            phase_fs(arn, st, args.session)
        elif args.phase == "turn":
            phase_turn(arn, st, args.repo, args.session)
        elif args.phase == "persist":
            phase_persist(arn, st, args.session)
        elif args.phase == "cleanup":
            phase_cleanup(arn, st)
        else:
            print(json.dumps(st["results"], indent=2, default=str)[:6000])
    finally:
        save_state(st)


if __name__ == "__main__":
    main()
