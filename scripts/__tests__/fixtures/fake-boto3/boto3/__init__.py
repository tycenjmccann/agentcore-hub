"""Fake boto3 for scripts/__tests__/live-verify-preflight.test.mjs (TEAM-5599).

Prepended to PYTHONPATH so tools/live-verify-preflight.sh imports this instead of
the real SDK: nothing here can reach AWS. Every call is appended to
$FAKE_BOTO3_LOG as one JSON line {"op": "<service>.<Operation>", "kw": {...}}.

$FAKE_BOTO3_SCENARIO is a JSON file {"rules": [...]}; the FIRST rule whose "op"
equals the call's op and whose optional "match" regex is found in the call's
JSON-encoded kwargs decides the outcome:
  {"error": "<Code>"}   raise a ClientError-shaped exception with that code
  {"response": {...}}   return it (after the age helpers below)
  {"store": true}       a DynamoDB Put/Update/DeleteItem the policy ALLOWS: its
                        ConditionExpression is evaluated against the scenario's
                        "items" {"<table>": [item, ...]} (attribute_exists /
                        attribute_not_exists joined by AND; a stored key
                        {"S": "prefix*"} matches by prefix), raising
                        ConditionalCheckFailedException when false, else applying
                        the write; the final items are dumped to $FAKE_BOTO3_STORE.
No matching rule → the DEFAULTS response (or {}).

Age helpers, so tests can state ages relative to "now":
  scan Items[*].scratchAgeHours       → scratchCreatedAt {"N": <epoch>}
  registryRecords[*].createdAtAgeHours → createdAt <datetime>
"""
import copy
import json
import os
import re
import time
from datetime import datetime, timezone

DEFAULTS = {
    "sts.GetCallerIdentity": {"Account": "111111111111", "Arn": "arn:aws:sts::111111111111:assumed-role/agentcore-hub-coding-pipeline-role/session"},
    "bedrock-agentcore-control.ListRegistries": {"registries": [{"name": "zz-live-verify", "registryId": "zzreg000000001"}]},
    "bedrock-agentcore-control.CreateRegistryRecord": {
        "recordArn": "arn:aws:bedrock-agentcore:us-east-1:111111111111:registry/zzreg000000001/record/rec000000001",
        "status": "CREATING"},
    "sts.AssumeRole": {"Credentials": {"AccessKeyId": "FAKEAKID", "SecretAccessKey": "FAKE-SECRET-KEY", "SessionToken": "FAKE-SESSION"}},
    "bedrock-agentcore.InvokeAgentRuntime": {"statusCode": 200},
    "s3.ListObjectsV2": {"CommonPrefixes": [{"Prefix": "workflows/wf1/"}], "Contents": [{"Key": "workflows/wf1/shared/brief.md"}]},
    "events.PutEvents": {"FailedEntryCount": 0, "Entries": [{"EventId": "e1"}]},
    "secretsmanager.GetSecretValue": {"SecretString": json.dumps({
        "site_url": "https://sandbox.example.atlassian.net", "email": "qa@example.com",
        "api_token": "FAKE-TOKEN-123", "project_key": "SBX"})},
}


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code, "Message": code}}


class _Body:
    def read(self, *_):
        return b"x"

    def close(self):
        pass


def _scenario():
    path = os.environ.get("FAKE_BOTO3_SCENARIO")
    if not path:
        return {"rules": []}
    with open(path) as f:
        return json.load(f)


def _camel(name):
    return "".join(p[:1].upper() + p[1:] for p in name.split("_"))


def _ages(resp):
    now = time.time()
    for item in resp.get("Items") or []:
        h = item.pop("scratchAgeHours", None)
        if h is not None:
            item["scratchCreatedAt"] = {"N": str(int(now - h * 3600))}
    for rec in resp.get("registryRecords") or []:
        h = rec.pop("createdAtAgeHours", None)
        if h is not None:
            rec["createdAt"] = datetime.fromtimestamp(now - h * 3600, timezone.utc)
    return resp


_STORE = None
_KEY_ATTRS = ("workflowId", "eventId", "ticketId")  # the lane tables' key attributes


def _store():
    global _STORE
    if _STORE is None:
        _STORE = copy.deepcopy(_scenario().get("items") or {})
    return _STORE


def _dump_store():
    path = os.environ.get("FAKE_BOTO3_STORE")
    if path:
        with open(path, "w") as f:
            json.dump(_store(), f)


def _condition_holds(expr, names, item):
    for term in expr.split(" AND "):
        m = re.fullmatch(r"\s*(attribute_exists|attribute_not_exists)\((#?\w+)\)\s*", term)
        if not m:
            raise ValueError(f"fake boto3 cannot evaluate {term!r}")
        attr = (names or {}).get(m.group(2), m.group(2))
        present = item is not None and attr in item
        if present != (m.group(1) == "attribute_exists"):
            return False
    return True


def _key_eq(stored, v):
    # A stored {"S": "prefix*"} stands for any key with that prefix (the script's keys carry an epoch).
    s = (stored or {}).get("S")
    if s and s.endswith("*"):
        return (v or {}).get("S", "").startswith(s[:-1])
    return stored == v


def _stored_write(op, kw):
    rows = _store().setdefault(kw["TableName"], [])
    src = kw.get("Key") or kw["Item"]
    key = {k: src[k] for k in _KEY_ATTRS if k in src}
    current = next((it for it in rows if all(_key_eq(it.get(k), v) for k, v in key.items())), None)
    if "ConditionExpression" in kw and not _condition_holds(kw["ConditionExpression"], kw.get("ExpressionAttributeNames"), current):
        _dump_store()
        raise ClientError("ConditionalCheckFailedException")
    if op.endswith("PutItem"):
        if current is not None:
            rows.remove(current)
        rows.append(kw["Item"])
    elif op.endswith("DeleteItem"):
        if current is not None:
            rows.remove(current)
    else:  # UpdateItem: record the touch
        if current is None:
            current = dict(kw["Key"]); rows.append(current)
        current["updated"] = {"BOOL": True}
    _dump_store()
    return {}


class _Client:
    def __init__(self, service):
        self._service = service

    def __getattr__(self, name):
        op = f"{self._service}.{_camel(name)}"

        def call(**kw):
            log = os.environ.get("FAKE_BOTO3_LOG")
            if log:
                with open(log, "a") as f:
                    f.write(json.dumps({"op": op, "kw": kw}, default=str) + "\n")
            blob = json.dumps(kw, default=str)
            for rule in _scenario().get("rules", []):
                if rule.get("op") != op:
                    continue
                if rule.get("match") and not re.search(rule["match"], blob):
                    continue
                if "error" in rule:
                    raise ClientError(rule["error"])
                if rule.get("store"):
                    return _stored_write(op, kw)
                return _ages(copy.deepcopy(rule.get("response", {})))
            resp = copy.deepcopy(DEFAULTS.get(op, {}))
            if op == "s3.GetObject":
                resp["Body"] = _Body()
            return resp

        return call


def client(service, region_name=None, **_):
    return _Client(service)
