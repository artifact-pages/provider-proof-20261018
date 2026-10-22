import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedBucket = "ap-proof-231136241959-20261018";
const allowedSites = new Set([
  "proof-a-20261018",
  "proof-b-20261018",
  "proof-neighbor-20261018",
]);
const bucket = process.env.AWS_PROOF_BUCKET;
const site = process.env.AWS_PROOF_SITE;

if (bucket !== expectedBucket || !allowedSites.has(site ?? "")) {
  throw new Error("AWS_PROOF_BUCKET or AWS_PROOF_SITE is outside the fixed proof target set");
}

const directory = mkdtempSync(join(tmpdir(), "provider-proof-p2-"));
const results = [];

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

function classifyFailure(stderr) {
  const code = stderr.match(/An error occurred \(([^)]+)\)/)?.[1] ?? null;
  const requestId = stderr.match(/Request ID:\s*([A-Za-z0-9]+)/i)?.[1] ?? null;
  if (["404", "NotFound", "NoSuchKey"].includes(code)) {
    return { outcome: "not-found-response", code, requestId };
  }
  if (["403", "AccessDenied"].includes(code)) {
    return { outcome: "denied-inconclusive", code, requestId };
  }
  return { outcome: "error", code, requestId };
}

function exactRead(operation, key) {
  const outputPath = join(directory, `${results.length}.object`);
  const args = operation === "head-object"
    ? ["s3api", operation, "--bucket", bucket, "--key", key, "--output", "json"]
    : ["s3api", operation, "--bucket", bucket, "--key", key, outputPath, "--output", "json"];
  const result = runAws(args);
  if (result.status === 0) {
    const data = operation === "get-object" ? readFileSync(outputPath) : Buffer.from(result.stdout);
    const value = {
      operation,
      key,
      outcome: "present-unexpectedly",
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    };
    results.push(value);
    return;
  }
  const failure = classifyFailure(result.stderr);
  results.push({ operation, key, ...failure, stderr: result.stderr.trim() });
}

function listPrefix(prefix) {
  const result = runAws([
    "s3api", "list-objects-v2", "--bucket", bucket,
    "--prefix", prefix, "--output", "json",
  ]);
  if (result.status !== 0) {
    results.push({ operation: "list-objects-v2", prefix, ...classifyFailure(result.stderr), stderr: result.stderr.trim() });
    return;
  }
  const listing = JSON.parse(result.stdout || "{}");
  const keys = (listing.Contents ?? []).map((item) => item.Key);
  results.push({
    operation: "list-objects-v2",
    prefix,
    outcome: keys.length === 0 ? "empty-listing" : "objects-present",
    keys,
  });
}

try {
  const keys = [
    "_indexes/sites.json",
    `_control/sites/${site}/lock.json`,
    `_indexes/${site}/index.json`,
  ];
  for (const key of keys) {
    exactRead("head-object", key);
    exactRead("get-object", key);
  }
  for (const prefix of [
    `_indexes/${site}/`,
    `_artifacts/${site}/`,
    `_previews/${site}/`,
    `_control/sites/${site}/`,
    "_indexes/sites.json",
  ]) {
    listPrefix(prefix);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const report = {
  bucket,
  site,
  recordedAt: new Date().toISOString(),
  results,
  interpretation: "AccessDenied is inconclusive for absence. Pair denied exact reads with complete permitted prefix listings and independent inventory before recording P2 pass.",
};
const json = JSON.stringify(report, null, 2);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\n### P2 absent probe record\n\n\`\`\`json\n${json}\n\`\`\`\n`);
}

if (results.some((item) => item.outcome === "present-unexpectedly" || item.outcome === "error")) {
  process.exitCode = 1;
}
