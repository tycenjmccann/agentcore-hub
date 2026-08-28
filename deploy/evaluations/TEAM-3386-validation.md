# TEAM-3386 — validation evidence for the reworked eval alarms

**Date:** 2026-08-28
**Branch:** `feature/TEAM-3386-backend-dev`
**Assets under test:** `deploy/evaluations/eval-success-rate-alarm.json`,
`deploy/evaluations/span-missing-alarm.json`

## Why the rework was needed (doc citation)

Per the authoritative AWS documentation,
[Create alarms on metric math expressions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Create-alarm-on-metric-math-expression.html):

> "You can't create an alarm based on the SEARCH expression."

(SEARCH in **dashboards** is legal — only alarms reject it. Alarms on plain
metric math over `MetricStat` entries, and on Metrics Insights queries, are
allowed.) The previous versions of both alarm JSONs built their ratios on
`SUM(SEARCH(...))` expressions, so `aws cloudwatch put-metric-alarm
--cli-input-json file://...` would be rejected by the service. The reworked
files use plain `MetricStat` entries against the dimensionless fleet-rollup
series the eval-packager now emits (EMF `Dimensions: [["AgentName"], []]`),
plus an `IF(total > 0, ..., ...)` zero-guard on each ratio.

## Environment

- `aws` CLI: **not installed** in this workspace (`aws: command not found`).
- Python `boto3 1.43.81` / `botocore 1.43.81` available, with live credentials:
  `arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/BedrockAgentCore-02f02adf-6862-4917-9f4b-70ef0da954ef`
  (via `sts get-caller-identity`).
- The CLI's `--cli-input-json` payload maps 1:1 to the `PutMetricAlarm` API
  parameters, so `boto3.client('cloudwatch').put_metric_alarm(**json.load(f))`
  exercises the identical request shape and endpoint the CLI command would.

## 1. Live PutMetricAlarm attempt (request reached the service — IAM-denied)

Command (region `us-east-1`, matching `AWS_REGION`/`AWS_DEFAULT_REGION`):

```python
import boto3, json
cw = boto3.client('cloudwatch', region_name='us-east-1')
for f in ['deploy/evaluations/eval-success-rate-alarm.json',
          'deploy/evaluations/span-missing-alarm.json']:
    cw.put_metric_alarm(**json.load(open(f)))
```

Output, verbatim:

```
--- put_metric_alarm <- deploy/evaluations/eval-success-rate-alarm.json (region us-east-1)
ERROR: ClientError
ClientError('An error occurred (AccessDenied) when calling the PutMetricAlarm operation: User: arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/BedrockAgentCore-02f02adf-6862-4917-9f4b-70ef0da954ef is not authorized to perform: cloudwatch:PutMetricAlarm on resource: arn:aws:cloudwatch:us-east-1:838829463875:alarm:agentcore-hub-eval-success-rate because no identity-based policy allows the cloudwatch:PutMetricAlarm action')
--- put_metric_alarm <- deploy/evaluations/span-missing-alarm.json (region us-east-1)
ERROR: ClientError
ClientError('An error occurred (AccessDenied) when calling the PutMetricAlarm operation: User: arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/BedrockAgentCore-02f02adf-6862-4917-9f4b-70ef0da954ef is not authorized to perform: cloudwatch:PutMetricAlarm on resource: arn:aws:cloudwatch:us-east-1:838829463875:alarm:agentcore-hub-eval-span-missing-ratio because no identity-based policy allows the cloudwatch:PutMetricAlarm action')
```

**What this proves.** The `AccessDenied` came from the CloudWatch endpoint,
not from the client: botocore performs full client-side parameter validation
against the `PutMetricAlarmInput` shape *before* serializing a request (a
malformed payload raises `ParamValidationError` locally and never leaves the
machine), and the service authenticated the request and resolved the exact
per-alarm ARNs from our `AlarmName` fields
(`...alarm:agentcore-hub-eval-success-rate`,
`...alarm:agentcore-hub-eval-span-missing-ratio`) before denying on IAM. So
both payloads passed request-shape validation and reached the service; only
the runtime role's missing `cloudwatch:PutMetricAlarm` permission blocked
creation. No alarms were created, therefore no `delete-alarms` cleanup was
needed (that also means we did NOT leave pre-fix-data alarms live).

**Honest scope note.** AWS evaluates authorization before deep semantic
validation of the `Metrics` math, so an `AccessDenied` cannot by itself prove
the *semantic* acceptance of the expressions. The semantic risk the rework
removes is exactly the documented SEARCH rejection quoted above — and the
reworked files contain no SEARCH anywhere (locked by the
`TEAM-3386: alarm asset shape` tests in
`lambda/eval-packager/index.test.mjs`). The remaining math
(`MetricStat` + `IF()` over scalar ids) is the documented, alarm-legal form.
Final confirmation happens at rollout when an operator with
`cloudwatch:PutMetricAlarm` applies the files (see the deployment-order notes
in each `AlarmDescription` and `setup-evaluations.sh`).

## 2. Offline botocore input-shape validation (explicit)

```python
from botocore.validate import validate_parameters
import botocore.session, json
model = botocore.session.get_session().get_service_model('cloudwatch')
shape = model.operation_model('PutMetricAlarm').input_shape
validate_parameters(json.load(open(f)), shape)
```

Output, verbatim:

```
botocore 1.43.81 | validating against input shape: PutMetricAlarmInput
deploy/evaluations/eval-success-rate-alarm.json: PARAMETER VALIDATION PASSED (no ParamValidationError raised)
deploy/evaluations/span-missing-alarm.json: PARAMETER VALIDATION PASSED (no ParamValidationError raised)
```

## 3. Test suite

`npx vitest run lambda/eval-packager` (vitest 2.1.9):

```
 ✓ lambda/eval-packager/index.test.mjs (111 tests) 388ms
 ✓ lambda/eval-packager/lib/classify.test.mjs (53 tests) 24ms

 Test Files  2 passed (2)
      Tests  164 passed (164)
```

New/updated coverage for this ticket (in `index.test.mjs`):

- `emitEvalMetrics` EMF record declares exactly the two dimension sets
  `[['AgentName'], []]` (per-agent + dimensionless fleet rollup), with metric
  names, units, and values unchanged.
- For both alarm JSONs: no `Metrics` entry contains a SEARCH expression;
  every non-expression entry is a `MetricStat` with Namespace
  `AgentCoreHub/Evaluations`, `Dimensions: []`, `Period: 3600`, `Stat: "Sum"`,
  `ReturnData: false`; the single `ReturnData: true` entry is exactly the
  IF() zero-guard.
- Pure-JS 3-of-4 alarm-math evaluator (Threshold/operator/periods read from
  the JSONs so drift breaks the tests), asserting exact per-datapoint values:
  healthy hours → OK; 3 breaching of 4 → ALARM; a total=0 hour (all-duplicates
  delivery) between breaching hours evaluates to rate=1 / ratio=0
  (non-breaching — unguarded it would be `0/0 = NaN`, i.e. a silent missing
  datapoint), so 2-of-4 does NOT alarm; span-missing guard: total=0 ⇒ ratio 0,
  non-breaching for GreaterThanThreshold 0.5.
