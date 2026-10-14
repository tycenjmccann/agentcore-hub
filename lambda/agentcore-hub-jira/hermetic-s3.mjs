// Test-only (TEAM-5892): no jira test reaches real S3, whatever ARTIFACT_BUCKET/creds the
// runner inherits. Default for EVERY S3Client instance (incl. cache-busted index.mjs
// copies) is NoSuchKey/404 = "no record / fallback roster". A test's own `s3.send =`
// override is an own property and still wins over this prototype patch.
//
// Not part of the deploy zip: deploy/setup-tickets-lambda.mjs zips an explicit file list
// (index.mjs, fix-contract.mjs, gate-contract.mjs) and scripts/check-lambda-zip-manifest.sh
// only walks index.mjs's import closure, so this file never ships.
import { S3Client } from "@aws-sdk/client-s3";

//
// TEAM-5959: a PutObject succeeds (the twin's Done-intent fence RESERVES an absent record
// create-only; a 404 answer to a PUT would read as "the record vanished" and the fence
// would retry to its contended refusal). Tests that assert on the fence's writes install
// their own `s3.send`; this default only keeps a recordless Done closable.
S3Client.prototype.send = async (cmd) => {
  if (cmd?.constructor?.name === "PutObjectCommand") return { ETag: '"hermetic-put"' };
  throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
};
