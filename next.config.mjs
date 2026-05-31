import { execSync } from "child_process";

/** @type {import("next").NextConfig} */

const gitSha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); }
  catch { return "unknown"; }
})();

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  env: {
    NEXT_PUBLIC_BUILD_SHA: gitSha,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    NEXT_PUBLIC_TICKET_PROVIDER: process.env.TICKET_PROVIDER || "jira",
  },
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@aws-sdk/**"],
  },
  serverExternalPackages: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-lambda",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-cloudwatch-logs",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-bedrock-agentcore",
    "@aws-sdk/client-bedrock-agentcore-control",
    "@smithy/node-http-handler",
  ],
};

export default nextConfig;
