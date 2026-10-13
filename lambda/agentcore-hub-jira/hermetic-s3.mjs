// Test-only (TEAM-5892): no jira test reaches real S3, whatever ARTIFACT_BUCKET/creds the
// runner inherits. Default for EVERY S3Client instance (incl. cache-busted index.mjs
// copies) is NoSuchKey/404 = "no record / fallback roster". A test's own `s3.send =`
// override is an own property and still wins over this prototype patch.
//
// Not part of the deploy zip: deploy/setup-tickets-lambda.mjs zips an explicit file list
// (index.mjs, fix-contract.mjs, gate-contract.mjs) and scripts/check-lambda-zip-manifest.sh
// only walks index.mjs's import closure, so this file never ships.
import { S3Client } from "@aws-sdk/client-s3";

S3Client.prototype.send = async () => {
  throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
};
