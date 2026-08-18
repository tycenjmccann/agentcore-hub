/**
 * Connector credential storage — AWS Secrets Manager, under `connectors/<id>`.
 *
 * The secret bytes NEVER touch the registry (S3), DynamoDB, the orchestrator, a
 * trace log, or an LLM prompt. They are written here from a secure UI form and
 * read only by the runtime role at invocation time (see the runtime's connector
 * resolver). This module deliberately exposes no "get value" — the Next app has
 * no reason to read a connector secret back, and not offering it keeps the value
 * out of any response body. It only writes and reports existence.
 *
 * Mirrors src/lib/cloud-code/github-secrets.ts (the GitHub App key pattern).
 */

const REGION = process.env.AWS_REGION || "us-east-1";

/** Secrets Manager id for a connector's credential bundle. */
export function secretIdFor(connectorId: string): string {
  return `connectors/${connectorId}`;
}

/**
 * Store (create or overwrite) a connector's credential bundle as a JSON secret.
 * `values` keys must be the connector's declared secretKeys. Returns nothing —
 * the caller flips the connector status to "active", it does not echo the value.
 */
export async function putConnectorSecret(
  connectorId: string,
  values: Record<string, string>
): Promise<void> {
  const SecretString = JSON.stringify(values);
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const sm = new SecretsManagerClient({ region: REGION });
  const SecretId = secretIdFor(connectorId);
  try {
    await sm.send(new CreateSecretCommand({ Name: SecretId, SecretString }));
  } catch (e) {
    if ((e as { name?: string }).name === "ResourceExistsException") {
      await sm.send(new PutSecretValueCommand({ SecretId, SecretString }));
    } else {
      throw e;
    }
  }
}

/** True if a credential bundle exists for this connector (existence only — never
 *  returns the value). Used to reconcile status without exposing the secret. */
export async function connectorSecretExists(connectorId: string): Promise<boolean> {
  const { SecretsManagerClient, DescribeSecretCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const sm = new SecretsManagerClient({ region: REGION });
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: secretIdFor(connectorId) }));
    return true;
  } catch {
    return false;
  }
}

/** Delete a connector's credential bundle (best-effort — called on connector delete). */
export async function deleteConnectorSecret(connectorId: string): Promise<void> {
  const { SecretsManagerClient, DeleteSecretCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const sm = new SecretsManagerClient({ region: REGION });
  try {
    await sm.send(
      new DeleteSecretCommand({ SecretId: secretIdFor(connectorId), ForceDeleteWithoutRecovery: true })
    );
  } catch {
    /* already gone / never created */
  }
}
