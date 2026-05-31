"""
Minimal clean-room agent to test DynamoDB streaming writes.
No MCP, no gateway, no complex tooling — just Strands stream_async + DDB batch writes.
"""
import os
import json
import time
import logging
import asyncio

import boto3
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test-streaming")

app = BedrockAgentCoreApp()

# DDB config
EVENTS_TABLE = os.environ.get("EVENTS_TABLE", "agentcore-hub-events")
REGION = os.environ.get("AWS_REGION", "us-east-1")
_ddb = boto3.client("dynamodb", region_name=REGION)


@app.entrypoint
async def handler(payload_str, context):
    """Minimal handler: stream agent response, batch-write all events to DDB."""
    payload = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
    prompt = payload.get("prompt", "Write a brief 3-paragraph analysis of cloud computing trends.")
    workflow_id = payload.get("workflow_id", f"wf_test_clean_{int(time.time())}")
    agent_id = "test-streaming-agent"

    logger.info(f"Starting test-streaming agent, workflow={workflow_id}")

    # Publish agent.started
    _publish_single(workflow_id, agent_id, "agent.started", {"agentId": agent_id, "workflowId": workflow_id})

    # Create a simple agent with no tools
    agent = Agent(
        model="us.anthropic.claude-opus-4-6-v1",
        system_prompt="You are a helpful assistant. Write clear, detailed responses.",
        tools=[],
        callback_handler=None,
    )

    # Stream and buffer events
    final_text = ""
    buffered_events = []
    seq = 0

    async for event in agent.stream_async(prompt):
        if "data" in event and event["data"]:
            final_text += event["data"]
            buffered_events.append({
                "agentId": agent_id,
                "type": "text",
                "content": event["data"],
                "workflowId": workflow_id,
            })
        if "result" in event:
            pass  # just consume

    logger.info(f"Stream complete: {len(final_text)} chars, {len(buffered_events)} text events buffered")

    # Batch-write all events to DDB
    # CRITICAL: Table sort key is `timestamp`, NOT `eventId`.
    # Each item MUST have a unique timestamp to avoid overwrites/duplicates.
    written = 0
    failed = 0
    batch = []
    base_ts = int(time.time() * 1000)
    for detail in buffered_events:
        seq += 1
        event_id = f"{base_ts + seq}-{seq:06d}"
        # Use ISO timestamp with millisecond+seq precision for unique sort key
        unique_ts = f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())}.{seq:04d}Z"
        detail_map = {k: {"S": str(v)} for k, v in detail.items() if v is not None}
        batch.append({
            "PutRequest": {
                "Item": {
                    "workflowId": {"S": workflow_id},
                    "eventId": {"S": event_id},
                    "type": {"S": "agent.streaming"},
                    "detail": {"M": detail_map},
                    "timestamp": {"S": unique_ts},
                }
            }
        })
        if len(batch) == 25:
            w, f = _flush_batch(batch)
            written += w
            failed += f
            batch = []

    if batch:
        w, f = _flush_batch(batch)
        written += w
        failed += f

    logger.info(f"Batch-write complete: {written} written, {failed} failed out of {len(buffered_events)} total")

    # Publish agent.complete
    _publish_single(workflow_id, agent_id, "agent.complete", {
        "agentId": agent_id,
        "workflowId": workflow_id,
        "summary": f"Test complete. {len(buffered_events)} events buffered, {written} written, {failed} failed.",
    })

    # Yield final text for AgentCore response
    yield {"event": {"contentBlockDelta": {"delta": {"text": final_text}}}}


def _flush_batch(batch):
    """Write a batch of up to 25 items. Returns (written, failed) counts."""
    try:
        resp = _ddb.batch_write_item(RequestItems={EVENTS_TABLE: batch})
        unprocessed = resp.get("UnprocessedItems", {}).get(EVENTS_TABLE, [])
        return len(batch) - len(unprocessed), len(unprocessed)
    except Exception as e:
        logger.error(f"batch_write_item FAILED: {e}")
        return 0, len(batch)


def _publish_single(workflow_id, agent_id, event_type, detail):
    """Write a single event (for started/complete markers)."""
    try:
        event_id = f"{int(time.time() * 1000)}-0000"
        detail_map = {k: {"S": str(v)} for k, v in detail.items() if v is not None}
        _ddb.put_item(
            TableName=EVENTS_TABLE,
            Item={
                "workflowId": {"S": workflow_id},
                "eventId": {"S": event_id},
                "type": {"S": event_type},
                "detail": {"M": detail_map},
                "timestamp": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            },
        )
        logger.info(f"Published {event_type} for {workflow_id}")
    except Exception as e:
        logger.error(f"FAILED to publish {event_type}: {e}")


if __name__ == "__main__":
    app.run()
