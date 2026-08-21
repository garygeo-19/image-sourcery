import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");

test("capabilities reports the safe engine semantics and package version", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "imgsrcy-capabilities-"));
  // The handshake must not inspect or depend on the caller's config.
  writeFileSync(path.join(temporary, "image-sourcery.config.json"), "not json");

  try {
    const completed = spawnSync(process.execPath, [cli, "capabilities"], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.equal(completed.status, 0, completed.stderr);
    const report = JSON.parse(completed.stdout);
    const packageMetadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(report, {
      schemaVersion: 1,
      name: "image-sourcery",
      version: packageMetadata.version,
      capabilities: {
        "best.absoluteEvaluate": true,
        "attempts.confusedWith": true,
        "doctor.parallelStages": true,
        "bytes.judgeSaveBound": true,
        "attempts.providerFailures": true,
        "pipeline.stages": true,
        "pipeline.profiles": true,
        "select.defer": true,
        "scorer.titleAdjacency": true,
        "provider.corpus": true,
        "generate.refusesPerson": true,
        "out.failClosed": true,
        "http.retryAfter": true,
        "http.hostPacing": true,
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("doctor expands parallel stages", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "imgsrcy-doctor-"));
  const config = path.join(temporary, "config.json");
  writeFileSync(config, JSON.stringify({
    judge: { provider: "none" },
    pipeline: [{ parallel: [{ provider: "wikimedia" }, { provider: "openverse" }] }],
  }));

  try {
    const completed = spawnSync(process.execPath, [cli, "doctor", "--config", config], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, /wikimedia\s+✓ ready/);
    assert.match(completed.stdout, /openverse\s+✓ ready/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an explicit missing config fails closed instead of using judge none", () => {
  const completed = spawnSync(process.execPath, [cli, "doctor", "--config", "/definitely/missing/image-sourcery.json"], {
    encoding: "utf8",
  });
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /config file does not exist/);
  assert.doesNotMatch(completed.stdout, /Judge: none/);
});

test("find provenance preserves confusedWith at the top level and per attempt", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "imgsrcy-find-"));
  const output = path.join(temporary, "candidate.png");
  const preload = path.join(root, "tests", "fixtures", "mock-fetch.cjs");

  try {
    const completed = spawnSync(
      process.execPath,
      [
        "--require", preload,
        cli,
        "find", "specific subject",
        "--providers", "wikimedia",
        "--judge", "openai",
        "--out", output,
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        env: { ...process.env, OPENAI_API_KEY: "offline-test-key" },
      },
    );

    assert.equal(completed.status, 2, completed.stderr);
    const provenance = JSON.parse(readFileSync(`${output}.json`, "utf8"));
    assert.equal(provenance.confusedWith, "fixture lookalike");
    assert.equal(provenance.attempts[0].confusedWith, "fixture lookalike");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

// "An image that asserts something false is worse than no image at all." A rejected
// candidate left at the caller's requested path is indistinguishable, to anything
// downstream that checks whether the file exists, from one that passed.
test("a rejected candidate leaves a sidecar but no image", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "imgsrcy-failclosed-"));
  const output = path.join(temporary, "candidate.png");
  const preload = path.join(root, "tests", "fixtures", "mock-fetch.cjs");

  try {
    const completed = spawnSync(
      process.execPath,
      ["--require", preload, cli, "find", "specific subject",
       "--providers", "wikimedia", "--judge", "openai", "--out", output],
      { cwd: temporary, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "offline-test-key" } },
    );

    assert.equal(completed.status, 2, completed.stderr);
    assert.equal(existsSync(output), false, "a failed run must not leave an image at --out");
    // The decision trace is still written: a failure needs a record too.
    assert.equal(JSON.parse(readFileSync(`${output}.json`, "utf8")).ok, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("--write-on-fail opts back in to saving the rejected candidate", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "imgsrcy-writeonfail-"));
  const output = path.join(temporary, "candidate.png");
  const preload = path.join(root, "tests", "fixtures", "mock-fetch.cjs");

  try {
    const completed = spawnSync(
      process.execPath,
      ["--require", preload, cli, "find", "specific subject",
       "--providers", "wikimedia", "--judge", "openai", "--out", output, "--write-on-fail"],
      { cwd: temporary, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "offline-test-key" } },
    );

    assert.equal(completed.status, 2, completed.stderr);
    assert.equal(existsSync(output), true, "opting in must still save the bytes");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
