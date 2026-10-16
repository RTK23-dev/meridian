// Tests for the E1 acceptance (Bible section 19, E1). The script is TypeScript, so each run is a child process started with
// node --experimental-strip-types; this file is plain .mjs so that `npm test` (scripts/**/*.test.mjs) picks it up.
// Every run here is a dry run or a fail-closed refusal: no request leaves the process, and no key is used.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scriptPath = path.join(here, "e1-acceptance.ts");
const replayUrl = pathToFileURL(path.join(here, "e1-replay.ts")).href;
const fixture = JSON.parse(readFileSync(path.join(here, "fixtures", "e1-recorded.json"), "utf8"));
const DRY_RUN_KEY = "dry-run-placeholder-not-a-key";
const CHECK_NAMES = [
  "rendered",
  "resolution_1080x1920",
  "fps_30",
  "duration_within_tolerance",
  "audio_present_aac",
  "integrity_gate_pass",
  "ledger_one_render_entry",
  "ledger_actual_is_render_cost",
  "ledger_key_is_composition_hash",
  "reservation_released",
  "artifacts_written",
];

/** Runs the script (or a snippet of the same modules) and returns its exit code and output. */
function runNode(args, { drop = [], env = {} } = {}) {
  const childEnv = { ...process.env, NODE_ENV: "development", ...env };
  for (const name of drop) delete childEnv[name];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", scriptPath, ...args],
      { cwd: repoRoot, env: childEnv, maxBuffer: 32 * 1024 * 1024, timeout: 280_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

/** Runs an ES module snippet with the replay module loaded, and returns what it printed as JSON. */
function runReplaySnippet(body) {
  const source = `const replay = await import(${JSON.stringify(replayUrl)});\n${body}`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { cwd: repoRoot, env: { ...process.env, NODE_ENV: "development" }, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(JSON.parse(stdout));
      },
    );
  });
}

function parseReport(result) {
  return JSON.parse(result.stdout);
}

describe("E1 acceptance dry run", () => {
  it("passes every check on the recorded replay, with costs and probe results", async () => {
    const result = await runNode(["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result);
    assert.equal(report.schema, "meridian.e1_acceptance/v1");
    assert.equal(report.mode, "dry-run");
    assert.equal(report.backend, "memory");
    assert.equal(report.pass, true);
    assert.equal(report.billVerified, false, "the render adapter reads no bill, so the run never claims one");
    assert.equal(report.masters.length, 1);

    const master = report.masters[0];
    assert.deepEqual(Object.keys(master.checks).sort(), [...CHECK_NAMES].sort());
    for (const name of CHECK_NAMES) assert.equal(master.checks[name], true, `check ${name}`);
    assert.equal(master.failure, null);

    assert.equal(master.renderId, "hfr_e1_recorded_0001");
    assert.equal(master.probe.width, 1080);
    assert.equal(master.probe.height, 1920);
    assert.equal(master.probe.fps.value, 30);
    assert.equal(master.probe.audioPresent, true);
    assert.ok(Math.abs(master.probe.durationMs - 12000) <= 100, "probe duration within 100 ms of the EDL");

    // The fixed per-master lines (0.52) are reserved; only the render line (0.05) is spent, and the rest is released.
    assert.equal(master.cost.estimateUsd, 0.52);
    assert.equal(master.cost.reservedUsd, 0.52);
    assert.equal(master.cost.renderEstimateUsd, 0.05);
    assert.equal(master.cost.actualUsd, 0.05);
    assert.equal(master.cost.actualIsEstimate, true);
    assert.equal(master.cost.releasedUsd, 0.47);
    assert.equal(master.cost.finalReservedUsd, 0.05);

    assert.equal(master.ledger.length, 1);
    assert.equal(master.ledger[0].stage, "render");
    assert.equal(master.ledger[0].idempotencyKey, master.idempotencyKey);
    assert.match(master.idempotencyKey, /^sha256:[0-9a-f]{64}$/);

    for (const [name, id] of Object.entries(master.artifactIds)) {
      assert.match(id, /^art_/, `artifact ${name}`);
    }
    assert.ok(!result.stdout.includes(DRY_RUN_KEY), "the placeholder credential never appears in the report");
    assert.ok(!result.stderr.includes(DRY_RUN_KEY), "the placeholder credential never appears in the log");
  });

  it("runs three masters one after another, each with its own composition, key and ledger entry", async () => {
    const result = await runNode(["--dry-run", "--count", "3"]);
    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result);
    assert.equal(report.masters.length, 3);
    assert.equal(report.totals.passed, 3);
    assert.equal(new Set(report.masters.map((master) => master.idempotencyKey)).size, 3, "each composition has its own key");
    assert.equal(new Set(report.masters.map((master) => master.requestId)).size, 3);
    assert.equal(report.totals.estimateUsd, 1.56);
    assert.equal(report.totals.actualUsd, 0.15);
    assert.equal(report.totals.releasedUsd, 1.41);
  });

  it("keeps the ledger and the artifacts in the test helper's Postgres when asked", async () => {
    const result = await runNode(["--dry-run", "--with-database"]);
    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result);
    assert.match(report.backend, /^postgres \(pglite/);
    assert.equal(report.pass, true);
    assert.equal(report.masters[0].ledger[0].actualUsd, 0.05);
    assert.match(report.masters[0].artifactIds.renderedVideo, /^art_/);
  });
});

describe("E1 replay refuses drift", () => {
  it("refuses a different URL, a key on a signed URL, an extra call, unused steps and a body that is not the video", async () => {
    const results = await runReplaySnippet(`
      const { createReplay, loadRecording, DRY_RUN_KEY } = replay;
      const steps = loadRecording().render;
      const outcome = async (run) => { try { await run(); return "accepted"; } catch (error) { return error.message; } };
      const headers = { "x-api-key": DRY_RUN_KEY, "X-HeyGen-Client-Source": "hyperframes", "Idempotency-Key": "sha256:x:upload", "content-type": "application/json" };
      const out = {};

      let r = createReplay(steps);
      out.wrongUrl = await outcome(() => r.transport({ method: "GET", url: "https://api.heygen.com/v3/other", headers }));

      r = createReplay(steps);
      await r.transport({ method: "POST", url: steps[0].url, headers, body: "{}" });
      out.keyOnSignedUpload = await outcome(() => r.transport({ method: "PUT", url: steps[1].url, headers, body: new Uint8Array(3) }));

      r = createReplay(steps.slice(0, 1));
      await r.transport({ method: "POST", url: steps[0].url, headers, body: "{}" });
      out.extraCall = await outcome(() => r.transport({ method: "GET", url: "https://example.invalid/", headers: {} }));

      r = createReplay(steps);
      out.unused = await outcome(() => r.finish());

      r = createReplay([steps[7]]);
      out.probeOtherBytes = await outcome(() => r.transport({ method: "POST", url: steps[7].url, headers: {}, body: JSON.stringify({ source: { kind: "bytes", base64: "AAAA" } }) }));

      console.log(JSON.stringify(out));
    `);
    assert.match(results.wrongUrl, /expected POST https:\/\/api\.heygen\.com\/v3\/assets\/direct-uploads, but the engine sent GET https:\/\/api\.heygen\.com\/v3\/other/);
    assert.match(results.keyOnSignedUpload, /must not carry a credential/);
    assert.match(results.extraCall, /every recorded step was already used/);
    assert.match(results.unused, /recorded step\(s\) were not used/);
    assert.match(results.probeOtherBytes, /did not send the recorded body/);
  });
});

describe("E1 recorded fixture", () => {
  it("is internally consistent: the probe answers for the bytes that were downloaded and sent to it", () => {
    const steps = fixture.render;
    const download = steps.find((step) => step.label.startsWith("video download"));
    const probe = steps.find((step) => step.label.startsWith("integrity probe"));
    assert.ok(download && probe, "the render recording has a download and a probe");
    assert.equal(probe.requestBodyIncludes, download.bodyBase64, "the probe is asked about the downloaded bytes");
    assert.equal(probe.json.bytes, Buffer.from(download.bodyBase64, "base64").length);
    assert.equal(probe.json.width, 1080);
    assert.equal(probe.json.height, 1920);
    assert.equal(probe.json.fps.value, 30);
    assert.equal(probe.json.audioPresent, true);
    assert.match(fixture.provenance, /CONSTRUCTED, NOT CAPTURED/);
  });
});

describe("E1 acceptance fails closed", () => {
  it("reports NOT_CONNECTED for every connection a live run lacks, and spends nothing", async () => {
    const result = await runNode(["--org", "ws_e1_test", "--brand", "brand_e1_test"], { drop: ["DATABASE_URL"] });
    assert.equal(result.code, 3, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "NOT_CONNECTED");
    assert.equal(report.spend, "none");
    assert.equal(report.masters, undefined, "no master was started");
    const items = report.missing.map((missing) => missing.item).sort();
    assert.deepEqual(items, ["database", "heygen", "media_functions", "platform_size_limit"]);
    assert.match(result.stderr, /NOT_CONNECTED heygen: /);
    assert.match(result.stderr, /no request was sent and no budget was reserved/);
  });

  it("refuses bad usage with exit 2 and a usage message", async () => {
    const cases = [
      [[], /pass --dry-run, or --org/],
      [["--org", "ws_x"], /needs --brand/],
      [["--dry-run", "--count", "0"], /--count must be a whole number from 1 to 50/],
      [["--dry-run", "--count", "51"], /--count must be a whole number from 1 to 50/],
      [["--dry-run", "--budget-usd", "1.23456"], /at most four decimals/],
      [["--dry-run", "--database"], /--database is for a live run/],
      [["--org", "ws_x", "--brand", "brand_x", "--with-database"], /--with-database is for dry runs/],
      [["--org", "ws_x", "--brand", "brand_x", "--stock-uri", "https://example.invalid/a.mp4"], /must be a store:\/\/ URI/],
      [["--dry-run", "--bogus"], /Unknown option/],
    ];
    for (const [args, pattern] of cases) {
      const result = await runNode(args);
      assert.equal(result.code, 2, `exit code for ${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
  });
});
