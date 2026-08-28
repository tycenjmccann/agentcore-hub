import { DynamoDBClient, DescribeTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
const region = 'us-east-1';
const ddb = new DynamoDBClient({ region });
for (const name of ['agentcore-hub-eval-config']) {
  try {
    const d = await ddb.send(new DescribeTableCommand({ TableName: name }));
    console.log(`DescribeTable ${name}: status=${d.Table.TableStatus} items~${d.Table.ItemCount} keys=${JSON.stringify(d.Table.KeySchema)}`);
  } catch (e) { console.log(`DescribeTable ${name} FAIL: ${e.name}: ${e.message}`); }
  try {
    const g = await ddb.send(new GetItemCommand({ TableName: name, Key: { agentId: { S: 'qa-recon-nonexistent' } } }));
    console.log(`GetItem ${name}: OK (item ${g.Item ? 'found' : 'absent'})`);
  } catch (e) { console.log(`GetItem ${name} FAIL: ${e.name}: ${e.message}`); }
}
try {
  const br = new BedrockRuntimeClient({ region });
  const r = await br.send(new ConverseCommand({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    messages: [{ role: 'user', content: [{ text: 'Reply with the single word: ok' }] }],
    inferenceConfig: { maxTokens: 5 },
  }));
  console.log('Bedrock Converse OK:', JSON.stringify({ text: r.output?.message?.content?.[0]?.text, usage: r.usage, stopReason: r.stopReason }));
} catch (e) { console.log('Bedrock Converse FAIL:', e.name, e.message); }
