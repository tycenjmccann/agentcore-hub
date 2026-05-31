/**
 * Display brand for the app. Set via NEXT_PUBLIC_BRAND_NAME at build time.
 * Defaults to "AgentCore Hub" so the OSS install works out of the box.
 *
 * This only affects display strings (header, sidebar, page title). AWS resource
 * names (DynamoDB tables, Lambdas, IAM roles, runtime ARNs) are NOT
 * configurable — they are part of the application contract.
 */
export const BRAND_NAME =
  process.env.NEXT_PUBLIC_BRAND_NAME || "AgentCore Hub";
