#!/usr/bin/env bash
#
# live-verify-preflight.sh — prove the coding-runtime live-verify lane (TEAM-5599)
#
# Exercises every grant of HubLiveVerifyLane (and the HubLiveVerifyRead reads it
# leans on) with a no-op call, plus NEGATIVE rows that must be denied, and prints
# a markdown record (## Status / ## Timeline / ## Open items) whose table is
#   | # | grant | call | expected | actual | verdict |
# Exit 0 = every row matched, 1 = any mismatch, 2 = usage / setup error.
# The policy itself lives in deploy/coding-agent-runtime/setup-coding-runtime-role.sh.
#
# Usage:
#   tools/live-verify-preflight.sh [--out FILE]   # FILE e.g. shared/live-verify-preflight.md
#   tools/live-verify-preflight.sh --cleanup      # delete wf_scratch_* rows + zz-* records > 24h old
#   eval "$(tools/live-verify-preflight.sh --jira-env)"   # export JIRA_SANDBOX_*
#
# Safety, by construction:
#   - scratch rows use keys wf_scratch_preflight_<epoch> and are deleted in the run;
#   - a negative row can never mutate real data, even if the policy is wrong: the
#     non-scratch PutItem is conditional (attribute_not_exists) on a key no run
#     uses, the out-of-scratch registry Create targets a registry id that does not
#     exist, the Lambda negative is an Invoke DryRun, the rest are reads;
#   - secret values are never printed or kept: rows record ok/denied only.
#     --jira-env is the ONLY path that prints the token, and only when asked.
#
# Python + boto3 rather than the aws CLI: the coding-runtime image ships boto3 and
# no aws CLI (deploy/coding-agent-runtime/requirements.txt).
#
# Env: AWS_REGION (us-east-1), ARTIFACT_BUCKET (agentcore-hub-artifacts-<acct>-<region>),
#      EVENT_BUS (default), WORKFLOWS_TABLE / EVENTS_TABLE / TICKETS_TABLE,
#      LIVE_VERIFY_REGISTRY_ID (else looked up by name zz-live-verify),
#      JIRA_SANDBOX_SECRET_ID (agentcore-hub/live-verify/jira-sandbox-readonly)

set -euo pipefail

exec python3 - "$@" <<'PY'
import json, os, shlex, sys, time
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
EVENT_BUS = os.environ.get("EVENT_BUS") or "default"
WORKFLOWS = os.environ.get("WORKFLOWS_TABLE") or "agentcore-hub-workflows"
EVENTS = os.environ.get("EVENTS_TABLE") or "agentcore-hub-events"
TICKETS = os.environ.get("TICKETS_TABLE") or "agentcore-hub-tickets"
SESSIONS = "agentcore-hub-cloud-code-sessions"
REGISTRY_NAME = "zz-live-verify"
JIRA_SECRET = os.environ.get("JIRA_SANDBOX_SECRET_ID") or "agentcore-hub/live-verify/jira-sandbox-readonly"
SOURCE = "agentcore-hub.live-verify"
SCRATCH = "wf_scratch_"
MAX_AGE_S = 24 * 3600
# 12-16 alphanumerics: the registryId shape, so the call reaches IAM instead of
# failing validation. It does not exist, so even a wrongly allowed Create mutates nothing.
NONEXISTENT_REGISTRY = "zzpreflightnoexist"

DENIED_CODES = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
                "NotAuthorizedForSourceException", "NotAuthorizedForDetailTypeException"}
ABSENT_CODES = {"ResourceNotFoundException", "NoSuchKey", "NoSuchBucket", "NotFoundException"}


def usage(code):
    print("usage: live-verify-preflight.sh [--out FILE] | --cleanup | --jira-env", file=sys.stderr)
    sys.exit(code)


def error_code(e):
    return ((getattr(e, "response", None) or {}).get("Error") or {}).get("Code")


def classify(fn):
    """ok | denied | absent | error. Any refusal that is not an authorization
    refusal means IAM let the call through, so it counts as ok."""
    try:
        fn()
        return "ok"
    except Exception as e:  # noqa: BLE001 - classification is the point
        code = error_code(e)
        if code is None:
            return "error"
        if code in DENIED_CODES or code.startswith("AccessDenied"):
            return "denied"
        if code in ABSENT_CODES:
            return "absent"
        return "ok"


def s(v):
    return {"S": v}


def main(argv):
    out_file, mode = None, "preflight"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out" and i + 1 < len(argv):
            out_file = argv[i + 1]; i += 2; continue
        if a == "--cleanup":
            mode = "cleanup"
        elif a == "--jira-env":
            mode = "jira-env"
        elif a in ("-h", "--help"):
            usage(0)
        else:
            usage(2)
        i += 1

    c = lambda svc: boto3.client(svc, region_name=REGION)  # noqa: E731
    if mode == "jira-env":
        return jira_env(c)

    ident = c("sts").get_caller_identity()
    account, caller = ident["Account"], ident.get("Arn", "?")
    bucket = os.environ.get("ARTIFACT_BUCKET") or f"agentcore-hub-artifacts-{account}-{REGION}"
    registry_id = os.environ.get("LIVE_VERIFY_REGISTRY_ID") or lookup_registry(c("bedrock-agentcore-control"))

    if mode == "cleanup":
        return cleanup(c, registry_id)
    return preflight(c, account, caller, bucket, registry_id, out_file)


def lookup_registry(ctl):
    try:
        token = None
        while True:
            res = ctl.list_registries(**({"nextToken": token} if token else {}), maxResults=100)
            for r in res.get("registries") or []:
                if r.get("name") == REGISTRY_NAME:
                    return r.get("registryId")
            token = res.get("nextToken")
            if not token:
                return None
    except Exception:  # noqa: BLE001 - denied/unknown → the registry rows say so
        return None


# ─── preflight ───────────────────────────────────────────────────────────────
def preflight(c, account, caller, bucket, registry_id, out_file):
    s3, ddb, ev, ctl, sm, lam = (c("s3"), c("dynamodb"), c("events"), c("bedrock-agentcore-control"),
                                 c("secretsmanager"), c("lambda"))
    now = int(time.time())
    key = f"{SCRATCH}preflight_{now}"
    rows = []

    def row(grant, call, expected, fn, allow_na=False, absent_is="ok"):
        actual = classify(fn)
        if actual == "absent":
            actual = "n/a" if allow_na else absent_is
        ok = actual == expected or (allow_na and actual == "n/a")
        rows.append((grant, call, expected, actual, "match" if ok else "MISMATCH"))
        return actual

    def ranged_get(k):
        return lambda: s3.get_object(Bucket=bucket, Key=k, Range="bytes=0-0")["Body"].close()

    # S3 reads
    row("HubLiveVerifyRead", "s3 ListObjectsV2 workflows/", "ok",
        lambda: s3.list_objects_v2(Bucket=bucket, Prefix="workflows/", MaxKeys=1))
    shared_key = first_shared_key(s3, bucket)
    row("HubLiveVerifyRead", "s3 GetObject workflows/*/shared/* (1 byte)", "ok",
        ranged_get(shared_key) if shared_key else (lambda: missing()), allow_na=True)
    row("LaneArtifactRead", "s3 GetObject performance/index.json (1 byte)", "ok", ranged_get("performance/index.json"))
    row("LaneArtifactList", "s3 ListObjectsV2 performance/", "ok",
        lambda: s3.list_objects_v2(Bucket=bucket, Prefix="performance/", MaxKeys=1))

    # DynamoDB reads
    row("HubLiveVerifyRead", f"ddb GetItem {WORKFLOWS}", "ok",
        lambda: ddb.get_item(TableName=WORKFLOWS, Key={"workflowId": s(key)}))
    row("HubLiveVerifyRead", f"ddb Query {EVENTS}", "ok",
        lambda: ddb.query(TableName=EVENTS, KeyConditionExpression="workflowId = :w",
                          ExpressionAttributeValues={":w": s(key)}, Limit=1))
    row("HubLiveVerifyRead", f"ddb GetItem {TICKETS}", "ok",
        lambda: ddb.get_item(TableName=TICKETS, Key={"ticketId": s(key)}), allow_na=True)

    # Scratch writes: put (only if absent) → update (only if present) → delete
    for table, k in ((WORKFLOWS, {"workflowId": s(key)}),
                     (EVENTS, {"workflowId": s(key), "eventId": s("preflight")}),
                     (TICKETS, {"ticketId": s(key)})):
        pk = next(iter(k))
        na = table == TICKETS  # tickets table exists only with TICKET_PROVIDER=dynamodb
        row("LaneScratchRows", f"ddb PutItem {table} {key}", "ok",
            lambda t=table, k=k, pk=pk: ddb.put_item(TableName=t, Item={**k, "scratchCreatedAt": {"N": str(now)}},
                                                    ConditionExpression=f"attribute_not_exists({pk})"), allow_na=na)
        row("LaneScratchRows", f"ddb UpdateItem {table} {key}", "ok",
            lambda t=table, k=k, pk=pk: ddb.update_item(TableName=t, Key=k, UpdateExpression="SET scratchTouched = :t",
                                                       ConditionExpression=f"attribute_exists({pk})",
                                                       ExpressionAttributeValues={":t": {"N": str(now)}}), allow_na=na)
        row("LaneScratchRows", f"ddb DeleteItem {table} {key}", "ok",
            lambda t=table, k=k: ddb.delete_item(TableName=t, Key=k), allow_na=na)

    # NEGATIVE: non-scratch key. Conditional on absence, on a key no run uses.
    bad = {"workflowId": s(f"zz_not_scratch_{now}")}
    if row("LaneScratchRows (negative)", f"ddb PutItem {WORKFLOWS} zz_not_scratch_{now}", "denied",
           lambda: ddb.put_item(TableName=WORKFLOWS, Item=bad,
                                ConditionExpression="attribute_not_exists(workflowId)")) == "ok":
        classify(lambda: ddb.delete_item(TableName=WORKFLOWS, Key=bad))

    # Events
    row("LaneScratchEvents", f"events PutEvents scratch.preflight on {EVENT_BUS}", "ok",
        lambda: put_event(ev, "scratch.preflight"))
    row("LaneScratchEvents (negative)", "events PutEvents workflow.preflight", "denied",
        lambda: put_event(ev, "workflow.preflight"))

    # Registry
    row("LaneRegistryList", "agentcore ListRegistries", "ok", lambda: ctl.list_registries(maxResults=1))
    row("LaneRegistryList", "agentcore ListHarnesses", "ok", lambda: ctl.list_harnesses(maxResults=1))
    row("LaneRegistryList", "agentcore ListAgentRuntimes", "ok", lambda: ctl.list_agent_runtimes(maxResults=1))
    if registry_id:
        row("LaneRegistryRead", f"agentcore GetRegistry {REGISTRY_NAME}", "ok",
            lambda: ctl.get_registry(registryId=registry_id))
        row("LaneRegistryRead", f"agentcore ListRegistryRecords {REGISTRY_NAME}", "ok",
            lambda: ctl.list_registry_records(registryId=registry_id, maxResults=1))
        created = {}

        def create():
            res = ctl.create_registry_record(registryId=registry_id, name=f"zz-preflight-{now}",
                                             description="TEAM-5599 preflight scratch record",
                                             descriptorType="CUSTOM", descriptors={"custom": {"inlineContent": "{}"}})
            created["id"] = (res.get("recordArn") or "").split("/")[-1]
        row("LaneRegistryScratchWrite", f"agentcore CreateRegistryRecord zz-preflight-{now}", "ok", create)
        # Without a created record, probe Delete on a record id that cannot exist.
        rid = created.get("id") or "zzpreflight0"
        row("LaneRegistryScratchWrite", "agentcore DeleteRegistryRecord (scratch record)", "ok",
            lambda: delete_record(ctl, registry_id, rid))
    else:
        for call in (f"agentcore GetRegistry {REGISTRY_NAME}", f"agentcore ListRegistryRecords {REGISTRY_NAME}",
                     "agentcore CreateRegistryRecord", "agentcore DeleteRegistryRecord"):
            rows.append(("LaneRegistry*", call, "ok", f"unresolved ({REGISTRY_NAME} not found or not listable)", "MISMATCH"))
    row("LaneRegistryScratchWrite (negative)", "agentcore CreateRegistryRecord outside the scratch registry", "denied",
        lambda: ctl.create_registry_record(registryId=NONEXISTENT_REGISTRY, name=f"zz-preflight-{now}",
                                           descriptorType="CUSTOM", descriptors={"custom": {"inlineContent": "{}"}}))

    # Secrets: the value is discarded, never printed
    row("LaneJiraSandboxSecret", f"secretsmanager GetSecretValue {JIRA_SECRET}", "ok",
        lambda: sm.get_secret_value(SecretId=JIRA_SECRET) and None)
    row("(negative) GitHub App key", "secretsmanager GetSecretValue cloud-code/github-app", "denied",
        lambda: sm.get_secret_value(SecretId="cloud-code/github-app") and None)

    # Deliberate exclusions
    row("(negative) TEAM-4785", f"ddb DescribeTable {SESSIONS}", "denied",
        lambda: ddb.describe_table(TableName=SESSIONS))
    row("(negative) cd-registry", "s3 GetObject config/cd-registry.json (1 byte)", "denied",
        ranged_get("config/cd-registry.json"))
    row("(negative) no Lambda invoke", "lambda Invoke DryRun agentcore-hub-workflow-output", "denied",
        lambda: lam.invoke(FunctionName="agentcore-hub-workflow-output", InvocationType="DryRun"))

    md = render(rows, caller, now)
    print(md)
    if out_file:
        with open(out_file, "w") as f:
            f.write(md + "\n")
    return 1 if any(r[4] != "match" for r in rows) else 0


class _Missing(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


def missing():
    raise _Missing()


def first_shared_key(s3, bucket):
    try:
        res = s3.list_objects_v2(Bucket=bucket, Prefix="workflows/", Delimiter="/", MaxKeys=20)
        for p in res.get("CommonPrefixes") or []:
            got = s3.list_objects_v2(Bucket=bucket, Prefix=p["Prefix"] + "shared/", MaxKeys=1)
            for o in got.get("Contents") or []:
                return o["Key"]
    except Exception:  # noqa: BLE001 - the list row reports the denial
        pass
    return None


def put_event(ev, detail_type):
    res = ev.put_events(Entries=[{"Source": SOURCE, "DetailType": detail_type, "EventBusName": EVENT_BUS,
                                  "Detail": json.dumps({"preflight": True})}])
    if res.get("FailedEntryCount"):
        code = (res.get("Entries") or [{}])[0].get("ErrorCode") or "EntryFailed"
        err = Exception(code)
        err.response = {"Error": {"Code": code}}
        raise err


def delete_record(ctl, registry_id, record_id):
    # A just-created record is CREATING for a moment; a conflict still proves the grant.
    for attempt in range(5):
        try:
            return ctl.delete_registry_record(registryId=registry_id, recordId=record_id)
        except Exception as e:  # noqa: BLE001
            if error_code(e) != "ConflictException" or attempt == 4:
                raise
            time.sleep(2)


def render(rows, caller, now):
    bad = [r for r in rows if r[4] != "match"]
    when = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    verdict = "PASS" if not bad else "FAIL"
    lead = (f"{verdict}: {len(rows) - len(bad)} of {len(rows)} rows matched their expected result"
            + ("." if not bad else f"; {len(bad)} did not, listed under Open items.")
            + f" Run as {caller} in {REGION} at {when}.")
    out = ["# Live-verify preflight", "", "## Status", "", lead, "", "## Timeline", "",
           "| # | grant | call | expected | actual | verdict |", "|---|---|---|---|---|---|"]
    for n, (g, call, exp, act, v) in enumerate(rows, 1):
        out.append(f"| {n} | {g} | {call} | {exp} | {act} | {v} |")
    out += ["", "## Open items", ""]
    if bad:
        out += [f"- Row {rows.index(r) + 1}: `{r[1]}` expected {r[2]}, got {r[3]}." for r in bad]
    else:
        out.append("None.")
    return "\n".join(out)


# ─── --cleanup ───────────────────────────────────────────────────────────────
def cleanup(c, registry_id):
    ddb, ctl = c("dynamodb"), c("bedrock-agentcore-control")
    now = time.time()
    report, failed = [], False
    for table, keys in ((WORKFLOWS, ["workflowId"]), (EVENTS, ["workflowId", "eventId"]), (TICKETS, ["ticketId"])):
        pk = keys[0]
        try:
            for item in scan_scratch(ddb, table, pk, keys):
                created = item.get("scratchCreatedAt", {}).get("N")
                age = now - float(created) if created else None
                k = {name: item[name] for name in keys}
                label = "/".join(item[name]["S"] for name in keys)
                if age is not None and age <= MAX_AGE_S:
                    report.append((table, label, fmt_age(age), "kept"))
                    continue
                result = classify(lambda: ddb.delete_item(TableName=table, Key=k))
                failed |= result != "ok"
                report.append((table, label, fmt_age(age), "deleted" if result == "ok" else f"delete {result}"))
        except Exception as e:  # noqa: BLE001
            code = error_code(e) or type(e).__name__
            if code != "ResourceNotFoundException":
                failed = True
                report.append((table, "-", "-", f"scan failed: {code}"))
    if registry_id:
        try:
            token = None
            while True:
                res = ctl.list_registry_records(registryId=registry_id, maxResults=100,
                                                **({"nextToken": token} if token else {}))
                for r in res.get("registryRecords") or []:
                    name = r.get("name") or ""
                    if not name.startswith("zz-"):
                        continue
                    age = now - to_epoch(r.get("createdAt")) if r.get("createdAt") else None
                    if age is not None and age <= MAX_AGE_S:
                        report.append((REGISTRY_NAME, name, fmt_age(age), "kept"))
                        continue
                    result = classify(lambda: ctl.delete_registry_record(registryId=registry_id, recordId=r["recordId"]))
                    failed |= result != "ok"
                    report.append((REGISTRY_NAME, name, fmt_age(age), "deleted" if result == "ok" else f"delete {result}"))
                token = res.get("nextToken")
                if not token:
                    break
        except Exception as e:  # noqa: BLE001
            failed = True
            report.append((REGISTRY_NAME, "-", "-", f"list failed: {error_code(e) or type(e).__name__}"))
    else:
        report.append((REGISTRY_NAME, "-", "-", "skipped: registry not found"))
    print("| target | key | age | action |\n|---|---|---|---|")
    for t, k, a, act in report:
        print(f"| {t} | {k} | {a} | {act} |")
    return 1 if failed else 0


def scan_scratch(ddb, table, pk, keys):
    start = None
    while True:
        kw = {"TableName": table, "FilterExpression": "begins_with(#pk, :p)",
              "ExpressionAttributeNames": {"#pk": pk}, "ExpressionAttributeValues": {":p": s(SCRATCH)},
              "ProjectionExpression": ", ".join(["#k%d" % i for i in range(len(keys))] + ["scratchCreatedAt"])}
        kw["ExpressionAttributeNames"].update({"#k%d" % i: k for i, k in enumerate(keys)})
        if start:
            kw["ExclusiveStartKey"] = start
        res = ddb.scan(**kw)
        for item in res.get("Items") or []:
            # The filter already applies; re-check so a wrong filter can never widen a delete.
            if item.get(pk, {}).get("S", "").startswith(SCRATCH):
                yield item
        start = res.get("LastEvaluatedKey")
        if not start:
            return


def to_epoch(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    return v.timestamp()


def fmt_age(age):
    return "unknown" if age is None else f"{age / 3600:.1f}h"


# ─── --jira-env ──────────────────────────────────────────────────────────────
def jira_env(c):
    try:
        raw = c("secretsmanager").get_secret_value(SecretId=JIRA_SECRET)["SecretString"]
    except Exception as e:  # noqa: BLE001
        print(f"✗ cannot read {JIRA_SECRET}: {error_code(e) or type(e).__name__}", file=sys.stderr)
        return 1
    data = json.loads(raw)
    missing_keys = [k for k in ("site_url", "email", "api_token", "project_key") if not data.get(k)]
    if missing_keys:
        print(f"✗ {JIRA_SECRET} is missing: {', '.join(missing_keys)}", file=sys.stderr)
        return 1
    for k in ("site_url", "email", "api_token", "project_key"):
        print(f"export JIRA_SANDBOX_{k.upper()}={shlex.quote(str(data[k]))}")
    return 0


sys.exit(main(sys.argv[1:]))
PY
