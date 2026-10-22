import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "0.4.4";
const site = "proof-a-20261018";
const expectedCompatibilityError = 'key "_indexes/proof-a-20261018/index.json" has unknown HTTP policy';
const binaryName = `artifact-pages_v${version}_linux_amd64`;
const release = `https://github.com/artifact-pages/artifact-pages/releases/download/v${version}`;
const temporary = mkdtempSync(join(tmpdir(), "provider-proof-044-rejection-"));
try {
  const binary = join(temporary, binaryName);
  const checksums = join(temporary, "checksums.txt");
  for (const [url, output] of [
    [`${release}/${binaryName}`, binary],
    [`${release}/artifact-pages_v${version}_checksums.txt`, checksums],
  ]) {
    const download = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", url, "--output", output], { encoding: "utf8" });
    if (download.status !== 0) {
      throw new Error(`Could not download the official ${version} CLI release asset: ${download.stderr}`);
    }
  }
  const expected = readFileSync(checksums, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trimEnd().endsWith(`  ${binaryName}`))
    .map((line) => line.trim().split(/\s+/)[0]);
  if (expected.length !== 1 || !/^[0-9a-f]{64}$/.test(expected[0])) {
    throw new Error(`Official checksums do not contain one valid entry for ${binaryName}`);
  }
  const verify = spawnSync("sha256sum", ["--check", "--status"], {
    input: `${expected[0]}  ${binary}\n`,
    encoding: "utf8",
  });
  if (verify.status !== 0) {
    throw new Error(`Official checksum verification failed for ${binaryName}`);
  }
  chmodSync(binary, 0o755);

  const result = spawnSync(binary, [
    "site", "sync", "--site", site, "--source", "sites/a", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json",
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 1) {
    throw new Error(`Released CLI 0.4.4 exit code was ${result.status ?? "unavailable"}; expected 1 for a site publish compatibility failure`);
  }
  let failure;
  try {
    failure = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new Error(`Released CLI 0.4.4 did not return its JSON failure envelope: ${error.message}`);
  }
  // 0.4.4 cli/internal/publisher/site_publish_state.go:
  // return fmt.Errorf("key %q has unknown HTTP policy", row.Key)
  if (typeof failure.error !== "string" || !failure.error.endsWith(expectedCompatibilityError)) {
    throw new Error(`Released CLI 0.4.4 error did not end with the exact compatibility message ${JSON.stringify(expectedCompatibilityError)}: ${failure.error ?? "missing error field"}`);
  }
  const record = {
    cli: version,
    site,
    source: "sites/a",
    dryRun: true,
    expectedExitCode: 1,
    expectedCompatibilityError,
    exitCode: result.status,
    error: failure.error,
    snapshotReminder: "Compare the complete reviewed pre-migration projection and control-state snapshot after this operation.",
  };
  console.log(JSON.stringify(record, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\n### CLI 0.4.4 pre-write rejection\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`, { flag: "a" });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
