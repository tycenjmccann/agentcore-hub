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

export const config = {
  deploymentUrl: DEPLOYMENT_URL,
  authToken: AUTH_TOKEN,
} as const;
