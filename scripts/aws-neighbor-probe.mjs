import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedBucket = "ap-proof-231136241959-20261018";
const expectedSite = "proof-a-20261018";
const bucket = process.env.AWS_PROOF_BUCKET;
const site = process.env.AWS_PROOF_SITE;

if (bucket !== expectedBucket || site !== expectedSite) {
  throw new Error("AWS_PROOF_BUCKET or AWS_PROOF_SITE is outside the fixed proof target set");
}

const directory = mkdtempSync(join(tmpdir(), "provider-proof-p1-"));
const results = [];
const unexpected = [];

function runAws(args) {
  const result = spawnSync("aws", ["--no-cli-pager", ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function failureDetails(stderr) {
  const code = stderr.match(/An error occurred \(([^)]+)\)/)?.[1] ?? null;
  const requestId = stderr.match(/Request\s*ID:\s*([A-Za-z0-9]+)/i)?.[1] ?? null;
  return { code, requestId };
}

function classify(result) {
  if (result.status === 0) return { outcome: "allowed", code: null, requestId: null };
  const { code, requestId } = failureDetails(result.stderr);
  if (["AccessDenied", "403", "Forbidden", "AccessDeniedException"].includes(code)) {
    return { outcome: "denied", code, requestId };
  }
  if (["404", "NotFound", "NoSuchKey"].includes(code)) {
    return { outcome: "not-found", code, requestId };
  }
  return { outcome: "other", code, requestId };
}

function record({ group, operation, target, expected, args, objectPath, countKeys = false }) {
  const result = runAws(args);
  const classification = classify(result);
  if (!classification.requestId) {
    classification.requestId = result.stdout.match(/"RequestId"\s*:\s*"([A-Za-z0-9-]+)"/i)?.[1] ?? null;
  }
  const entry = {
    group,
    operation,
    target,
    expected,
    ...classification,
    stderr: result.stderr.trim(),
  };
  if (result.status === 0 && objectPath) {
    entry.sha256 = createHash("sha256").update(readFileSync(objectPath)).digest("hex");
  }
  if (result.status === 0 && countKeys) {
    const listing = JSON.parse(result.stdout || "{}");
    entry.keyCount = (listing.Contents ?? []).length;
  }
  results.push(entry);
  if (classification.outcome !== expected) {
    unexpected.push({ group, operation, target, expected, outcome: classification.outcome, code: classification.code });
  }
}

function getObject(group, key, expected, alternateBucket = bucket) {
  const objectPath = join(directory, `${results.length}.object`);
  record({
    group,
    operation: "get-object",
    target: `${alternateBucket}/${key}`,
    expected,
    args: ["s3api", "get-object", "--bucket", alternateBucket, "--key", key, objectPath, "--output", "json"],
    objectPath,
  });
}

function listObjects(group, prefix, expected, options = {}) {
  const targetBucket = options.bucket ?? bucket;
  const args = ["s3api", "list-objects-v2", "--bucket", targetBucket];
  if (prefix !== undefined) args.push("--prefix", prefix);
  if (options.maxKeys !== undefined) args.push("--max-keys", String(options.maxKeys));
  args.push("--output", "json");
  record({
    group,
    operation: "list-objects-v2",
    target: options.maxKeys !== undefined ? `${targetBucket} (max-keys ${options.maxKeys})` : `${targetBucket}/${prefix}`,
    expected,
    args,
    countKeys: expected === "allowed",
  });
}

try {
  for (const key of [
    "_indexes/proof-neighbor-20261018/p1.json",
    "_artifacts/proof-neighbor-20261018/p1.txt",
    "_previews/proof-neighbor-20261018/p1.json",
    "_control/sites/proof-neighbor-20261018/p1.json",
  ]) getObject("neighbor-markers", key, "denied");

  for (const key of [
    "_indexes/proof-neighbor-20261018/index.json",
    "_artifacts/proof-neighbor-20261018/index.html",
  ]) getObject("neighbor-published-objects", key, "denied");

  for (const key of [
    "_indexes/proof-b-20261018/index.json",
    "_artifacts/proof-b-20261018/index.html",
  ]) getObject("site-b-published-objects", key, "denied");

  for (const prefix of [
    "_artifacts/proof-neighbor-20261018/",
    "_control/sites/proof-neighbor-20261018/",
    "_artifacts/proof-b-20261018/",
  ]) listObjects("neighbor-and-b-listings", prefix, "denied");

  getObject("own-positive-controls", "_indexes/proof-a-20261018/index.json", "allowed");
  getObject("own-positive-controls", "_artifacts/proof-a-20261018/index.html", "allowed");
  listObjects("own-positive-controls", "_control/sites/proof-a-20261018/", "allowed");
  listObjects("own-positive-controls", "_previews/proof-a-20261018/", "allowed");

  const preservedBucket = "artifact-pages-231136241959-us-east-1";
  getObject("preserved-resources", "_indexes/sites.json", "denied", preservedBucket);
  listObjects("preserved-resources", undefined, "denied", { bucket: preservedBucket, maxKeys: 1 });
  record({
    group: "preserved-resources",
    operation: "get-distribution",
    target: "ECFTIR5GVPQDF",
    expected: "denied",
    args: ["cloudfront", "get-distribution", "--id", "ECFTIR5GVPQDF", "--output", "json"],
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const report = { bucket, site, recordedAt: new Date().toISOString(), results, unexpected };
console.log(JSON.stringify(report, null, 2));
if (unexpected.length > 0) process.exitCode = 1;
