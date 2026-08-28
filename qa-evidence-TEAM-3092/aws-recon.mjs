import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
const region = 'us-east-1';
try {
  const sts = new STSClient({ region });
  const id = await sts.send(new GetCallerIdentityCommand({}));
  console.log('STS OK:', JSON.stringify({ Account: id.Account, Arn: id.Arn, UserId: id.UserId }));
} catch (e) { console.log('STS FAIL:', e.name, e.message); }
try {
  const ddb = new DynamoDBClient({ region });
  const t = await ddb.send(new ListTablesCommand({}));
  console.log('DDB ListTables OK:', JSON.stringify(t.TableNames));
  for (const name of (t.TableNames||[]).filter(n => /eval/i.test(n))) {
    try {
      const d = await ddb.send(new DescribeTableCommand({ TableName: name }));
      console.log(`DDB DescribeTable ${name}: status=${d.Table.TableStatus} items~${d.Table.ItemCount} keys=${JSON.stringify(d.Table.KeySchema)}`);
    } catch (e) { console.log(`DDB DescribeTable ${name} FAIL:`, e.name, e.message); }
  }
} catch (e) { console.log('DDB FAIL:', e.name, e.message); }
