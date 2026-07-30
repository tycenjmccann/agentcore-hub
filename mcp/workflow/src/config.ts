const DEPLOYMENT_URL = (process.env.DEPLOYMENT_URL || "").replace(/\/$/, "");

if (!DEPLOYMENT_URL) {
  process.stderr.write(
    "FATAL: DEPLOYMENT_URL environment variable is required.\n"
  );
  process.exit(1);
}

if (!/^https?:\/\/.+/.test(DEPLOYMENT_URL)) {
  process.stderr.write(
    "FATAL: DEPLOYMENT_URL must be a valid HTTP(S) URL.\n"
  );
  process.exit(1);
}

const AUTH_TOKEN: string | undefined = process.env.AUTH_TOKEN || undefined;

// Cloudflare Access service-token credentials. When the Hub runs with
// AUTH_MODE=cloudflare-access, the middleware only accepts a verified
// Cf-Access-Jwt-Assertion — it never reads Authorization. A machine client
// authenticates by presenting a service token via these two headers; Access
// validates them at the edge and injects the JWT the middleware expects.
// (See src/lib/auth/adapters/cloudflare-access.ts.)
const CF_ACCESS_CLIENT_ID: string | undefined =
  process.env.CF_ACCESS_CLIENT_ID || undefined;
const CF_ACCESS_CLIENT_SECRET: string | undefined =
  process.env.CF_ACCESS_CLIENT_SECRET || undefined;

export const config = {
  deploymentUrl: DEPLOYMENT_URL,
  authToken: AUTH_TOKEN,
  cfAccessClientId: CF_ACCESS_CLIENT_ID,
  cfAccessClientSecret: CF_ACCESS_CLIENT_SECRET,
} as const;
