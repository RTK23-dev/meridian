// The stability gate. It runs the checks that say whether the repository is in a known good state, in order, and prints each count
// against the baseline recorded in .claude/loop/RUN_PLAN.md. It sends no provider request.
//
// The gate exits 0 only when every required check passed. A check that could not run (the browser, for example) is reported as
// "not run" and makes the gate incomplete, exit 2. It is never counted as a pass. The engine dry run is reported on its own line: it
// is a known red that needs an owner decision (Q2), so it does not fail the gate.
//
// Each check's full output is kept in artifacts/gate/. Run it from the repository root: npm run gate

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_DIR = join(ROOT, "artifacts", "gate");

/** The counts on main at 0aa3301 (PR #85). A run may improve on them, never fall below them. */
const BASELINE = {
  lintErrors: 0,
  sourcePass: 6649,
  scriptsPass: 217,
  acceptancePass: 25,
};

/** The step that is running now, so a stop can say where it happened. */
let current = "before the first step";

// A stop from outside is recorded, so a run that is cut short says where, instead of leaving an empty log.
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`gate: stopped by ${signal} during ${current}; no verdict`);
    process.exit(130);
  });
}

/** Writes one step's full output to artifacts/gate/ as soon as the step ends, so a stop keeps every finished step. */
function finish(name, code, output) {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(join(LOG_DIR, `${name.replaceAll(" ", "-")}.log`), output);
  console.log(`gate: finished ${name} (exit ${code})`);
  return { name, code, output };
}

/** Runs one command from the repository root and resolves with its exit code and everything it printed. */
function run(name, command, args, env = process.env) {
  return new Promise((resolve) => {
    current = name;
    console.log(`gate: running ${name}`);
    const child = spawn(command, args, { cwd: ROOT, env });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => resolve(finish(name, 1, `${output}${error.message}`)));
    child.once("close", (code) => resolve(finish(name, code, output)));
  });
}

/** Reads the totals that `node --test --test-reporter=tap` prints at the end. */
function tapTotals(output) {
  const read = (key) => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: read("tests"),
    pass: read("pass"),
    fail: read("fail") ?? 0,
    cancelled: read("cancelled") ?? 0,
    skipped: read("skipped") ?? 0,
  };
}

/** Reads eslint's summary line. A clean run prints no summary, so no summary means no problems. */
function lintTotals(output) {
  const match = output.match(/\((\d+) errors?, (\d+) warnings?\)/);
  return match ? { errors: Number(match[1]), warnings: Number(match[2]) } : { errors: 0, warnings: 0 };
}

/** Reads the browser acceptance's final line, and tells a browser that could not launch apart from a failed check. */
function acceptanceTotals(output) {
  const match = output.match(/^SUMMARY (\d+) pass, (\d+) fail$/m);
  if (match) return { pass: Number(match[1]), fail: Number(match[2]) };
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/.test(output)) return { notRun: "browser" };
  return { notRun: "no summary line" };
}

const steps = [];

const typecheck = await run("typecheck", "npm", ["run", "typecheck"]);
steps.push({ name: "typecheck", result: typecheck, status: typecheck.code === 0 ? "pass" : "fail", detail: "tsc --noEmit" });

const lint = await run("lint", "npm", ["run", "lint"]);
const lintCounts = lintTotals(lint.output);
steps.push({
  name: "lint",
  result: lint,
  status: lint.code === 0 && lintCounts.errors === BASELINE.lintErrors ? "pass" : "fail",
  detail: `${lintCounts.errors} errors, ${lintCounts.warnings} warnings (baseline 0 errors)`,
});

const scripts = await run(
  "scripts tests",
  "node",
  ["--test", "--test-reporter=tap", "scripts/**/*.test.mjs"],
  { ...process.env, NODE_ENV: "development" },
);
const scriptTotals = tapTotals(scripts.output);
steps.push({
  name: "scripts tests",
  result: scripts,
  status:
    scripts.code === 0 && scriptTotals.fail === 0 && scriptTotals.cancelled === 0 && scriptTotals.pass >= BASELINE.scriptsPass
      ? "pass"
      : "fail",
  detail: `${scriptTotals.tests} tests: ${scriptTotals.pass} pass, ${scriptTotals.fail} fail, ${scriptTotals.skipped} skipped (baseline ${BASELINE.scriptsPass} pass)`,
});

const source = await run(
  "source tests",
  "node",
  ["--experimental-strip-types", "--test", "--test-reporter=tap", "src/**/*.test.ts"],
  { ...process.env, NODE_ENV: "development" },
);
const sourceTotals = tapTotals(source.output);
steps.push({
  name: "source tests",
  result: source,
  status:
    source.code === 0 && sourceTotals.fail === 0 && sourceTotals.cancelled === 0 && sourceTotals.pass >= BASELINE.sourcePass
      ? "pass"
      : "fail",
  detail: `${sourceTotals.tests} tests: ${sourceTotals.pass} pass, ${sourceTotals.fail} fail, ${sourceTotals.skipped} skipped (baseline ${BASELINE.sourcePass} pass)`,
});

const build = await run("build", "npm", ["run", "build"]);
steps.push({ name: "build", result: build, status: build.code === 0 ? "pass" : "fail", detail: "npm run build" });

// GATE_ACCEPTANCE_NODE_OPTIONS applies to this step only, for example a Chromium path wrapper on a machine whose browser build differs.
const acceptanceEnv = { ...process.env };
if (process.env.GATE_ACCEPTANCE_NODE_OPTIONS) {
  acceptanceEnv.NODE_OPTIONS = process.env.GATE_ACCEPTANCE_NODE_OPTIONS;
}
const acceptance = await run("acceptance", "node", ["scripts/release-acceptance/run.mjs"], acceptanceEnv);
const acceptanceCounts = acceptanceTotals(acceptance.output);
if (acceptanceCounts.notRun) {
  steps.push({
    name: "acceptance",
    result: acceptance,
    status: "not run",
    detail: `not run: ${acceptanceCounts.notRun}`,
  });
} else {
  steps.push({
    name: "acceptance",
    result: acceptance,
    status:
      acceptance.code === 0 && acceptanceCounts.fail === 0 && acceptanceCounts.pass >= BASELINE.acceptancePass ? "pass" : "fail",
    detail: `${acceptanceCounts.pass} pass, ${acceptanceCounts.fail} fail (baseline ${BASELINE.acceptancePass})`,
  });
}

// Reported on its own line, and never part of the verdict (Q2).
const dryRun = await run("engine dry run", "npm", ["run", "engine:e1", "--", "--dry-run"]);
const dryRunLine = dryRun.output.match(/^E1 acceptance .*$/m)?.[0] ?? "no verdict line printed";


const width = Math.max(...steps.map((step) => step.name.length));
for (const step of steps) {
  console.log(`gate: ${step.name.padEnd(width)}  ${step.status.padEnd(7)}  ${step.detail}`);
}
console.log(`gate: ${"engine dry run".padEnd(width)}  known red  ${dryRunLine} (Q2; does not fail the gate)`);

const failed = steps.filter((step) => step.status === "fail");
const notRun = steps.filter((step) => step.status === "not run");
const verdict = failed.length > 0 ? "FAIL" : notRun.length > 0 ? "INCOMPLETE" : "PASS";
console.log(`gate: result  ${verdict}${failed.length ? ` (failed: ${failed.map((step) => step.name).join(", ")})` : ""}${notRun.length ? ` (not run: ${notRun.map((step) => step.name).join(", ")})` : ""}`);
console.log(`gate: full output in ${LOG_DIR}`);

process.exitCode = verdict === "PASS" ? 0 : verdict === "INCOMPLETE" ? 2 : 1;
