"""TEAM-5321: Errors alarms on the ticket + workflow-output Lambdas page a human
out of band (SMS + the Telegram bot) through agentcore-hub-ops-alarms, never Jira.

Text checks on lib/pipeline-stack.ts, like the other stack tests here: the CI
pytest battery has no deploy/pipeline/node_modules, so it cannot synth.
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
STACK = (HERE / "lib" / "pipeline-stack.ts").read_text()
BIN = (HERE / "bin" / "pipeline.ts").read_text()
FUNCTIONS = ("agentcore-hub-jira", "agentcore-hub-tickets", "agentcore-hub-workflow-output")


def strip_comments(src):
    # Line-based: a naive /* */ regex would eat code between "arn:...:*/..." strings.
    out = []
    for line in src.splitlines():
        if line.lstrip().startswith(("//", "/*", "*")):
            continue
        out.append(re.sub(r"\s//\s.*$", "", line))
    return "\n".join(out)


CODE = strip_comments(STACK)


def ops_section():
    start = CODE.index('new sns.Topic(this, "OpsAlarmTopic"')
    end = CODE.index("new subs.LambdaSubscription(telegramIntake)", start)
    return CODE[start:end + 200]


def alarm_block():
    start = CODE.index("new cloudwatch.Alarm(")
    return CODE[start:CODE.index("addAlarmAction", start)]


def test_one_errors_alarm_per_function():
    loop = re.search(r"for \(const fn of \[([^\]]*)\]\)\s*\{\s*const alarm = new cloudwatch\.Alarm", CODE)
    assert loop, "alarms must be created in one loop over the function names"
    names = re.findall(r'"([^"]+)"', loop.group(1))
    assert sorted(names) == sorted(FUNCTIONS)
    assert "alarmName: `${fn}-errors`" in CODE


def test_alarm_shape():
    block = alarm_block()
    for needle in (
        'namespace: "AWS/Lambda"',
        'metricName: "Errors"',
        "dimensionsMap: { FunctionName: fn }",
        'statistic: "Sum"',
        "period: Duration.seconds(60)",
        "evaluationPeriods: 5",
        "datapointsToAlarm: 2",
        "threshold: 0,",
        "ComparisonOperator.GREATER_THAN_THRESHOLD",
        "TreatMissingData.NOT_BREACHING",
    ):
        assert needle in block, needle
    assert "new cwactions.SnsAction(opsTopic)" in CODE


def test_topic_is_ssl_only():
    m = re.search(r'new sns\.Topic\(this, "OpsAlarmTopic", \{(.*?)\}\);', CODE, re.S)
    assert m
    assert 'topicName: "agentcore-hub-ops-alarms"' in m.group(1)
    assert "enforceSSL: true" in m.group(1)


def test_topic_policy_allows_cloudwatch_only():
    m = re.search(r"opsTopic\.addToResourcePolicy\((.*?)\n    \);", CODE, re.S)
    assert m, "the ops topic needs an explicit resource policy"
    policy = m.group(1)
    assert re.findall(r"new iam\.\w+Principal\([^)]*\)", policy) == [
        'new iam.ServicePrincipal("cloudwatch.amazonaws.com")'
    ]
    assert '"aws:SourceAccount": account' in policy
    assert 'actions: ["sns:Publish"]' in policy
    for bad in ("AnyPrincipal", "AccountRootPrincipal", "ArnPrincipal", '"*"'):
        assert bad not in policy, bad
    assert CODE.count("opsTopic.addToResourcePolicy(") == 1
    assert "opsTopic.grantPublish" not in CODE


def test_sms_subscription_only_when_configured():
    assert "if (opsAlarmSms) opsTopic.addSubscription(new subs.SmsSubscription(opsAlarmSms));" in CODE
    assert CODE.count("SmsSubscription") == 1
    assert "opsAlarmSms: process.env.OPS_ALARM_SMS || undefined" in BIN


def test_telegram_bot_subscribed_never_jira():
    section = ops_section()
    assert "function:telegram-bug-intake" in section
    assert "opsTopic.addSubscription(new subs.LambdaSubscription(telegramIntake))" in section
    subs = re.findall(r"opsTopic\.addSubscription\(new subs\.(\w+)\(", CODE)
    assert sorted(subs) == ["LambdaSubscription", "SmsSubscription"]
    # Only the alarm SOURCE may name jira; nothing it pages may.
    assert "jira" not in section.replace('"agentcore-hub-jira"', "").lower()


def test_no_approval_grant_added():
    assert "PutApprovalResult" not in CODE


def test_no_account_literal():
    assert not re.search(r"(?<!\d)\d{12}(?!\d)", STACK)
    assert not re.search(r"(?<!\d)\d{12}(?!\d)", BIN)


def test_topic_arn_is_an_output():
    assert 'new CfnOutput(this, "OpsAlarmTopicArn", { value: opsTopic.topicArn })' in CODE
