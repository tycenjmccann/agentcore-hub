/**
 * Cloud Code — GitHub App credential storage.
 *
 * The App's private key is the master credential the whole GitHub App design
 * keeps away from the microVM. It lives ONLY in AWS Secrets Manager (under
 * `cloud-code/github-app`), never in the artifact bucket: the coding-runtime
 * role can read the bucket, so an App key parked there would be reachable by an
 * untrusted agent. Secrets Manager is the one store the hub can hold this key in
 * that a session provably cannot reach.
 *
 * Dev / single-operator deploys with no Secrets Manager access can use the
 * GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY env override instead.
 */

const REGION = process.env.AWS_REGION || "us-east-1";
const GITHUB_APP_SECRET = "cloud-code/github-app";

export interface GithubAppSecret {
  appId: string;
  privateKey: string;
  slug?: string;
  webhookSecret?: string;
  // OAuth client creds (from the manifest conversion). Used to exchange the
  // install-callback `code` for a user token so we can prove the connecting user
  // actually controls the installation they're binding (see github-app.ts).
  clientId?: string;
  clientSecret?: string;
}

/** Read the GitHub App config (Secrets Manager, or the env override), or null. */
export async function getGithubAppConfig(): Promise<GithubAppSecret | null> {
  // An explicit env override wins (dev / single-operator). Newlines in the PEM
  // are escaped as \n in env, so unescape them.
  const envId = process.env.GITHUB_APP_ID;
  const envKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (envId && envKey) {
    return {
      appId: envId,
      privateKey: envKey.replace(/\\n/g, "\n"),
      slug: process.env.GITHUB_APP_SLUG,
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    };
  }
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const sm = new SecretsManagerClient({ region: REGION });
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: GITHUB_APP_SECRET }));
    return resp.SecretString ? (JSON.parse(resp.SecretString) as GithubAppSecret) : null;
  } catch {
    // Missing/forbidden → App simply not configured (fall back to GITHUB_PAT).
    return null;
  }
}

/** Store the GitHub App config (operator setup / manifest callback). Always
 *  Secrets Manager — the App key must never land in a runtime-readable store. */
export async function putGithubAppConfig(cfg: GithubAppSecret): Promise<void> {
  const SecretString = JSON.stringify(cfg);
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const sm = new SecretsManagerClient({ region: REGION });
  try {
    await sm.send(new CreateSecretCommand({ Name: GITHUB_APP_SECRET, SecretString }));
  } catch (e) {
    if ((e as { name?: string }).name === "ResourceExistsException") {
      await sm.send(new PutSecretValueCommand({ SecretId: GITHUB_APP_SECRET, SecretString }));
    } else {
      throw e;
    }
  }
}
