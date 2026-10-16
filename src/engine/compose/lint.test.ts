// `hyperframes lint` on compiled output (Bible 9.1 rule 7, 6.9): the EDL fixture and every component fixture must lint
// with zero errors and zero warnings. The linter is the HyperFrames CLI from node_modules. If it cannot run here,
// the tests are skipped with the reason printed, and nothing is reported as passing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { edlFixture, styleKitFixture } from "../contracts/fixtures/index.ts";
import { compile } from "./compiler.ts";
import { COMPONENT_LIBRARY } from "./components/index.ts";
import { buildHarness, CLI_PATH, removeHarness } from "./test/golden/harness.ts";

type LintReport = { ok: boolean; errorCount: number; warningCount: number; findings: unknown[] };

/** null when the CLI runs here; otherwise the reason the lint tests are skipped. */
function cliSkipReason(): string | null {
  if (!existsSync(CLI_PATH)) {
    return `the HyperFrames CLI is not installed at ${CLI_PATH}`;
  }
  const run = spawnSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8", timeout: 60_000 });
  if (run.error || run.status !== 0) {
    return `the HyperFrames CLI does not run in this environment: ${run.error?.message ?? run.stderr}`;
  }
  return null;
}

function lint(dir: string): LintReport {
  const run = spawnSync(process.execPath, [CLI_PATH, "lint", dir, "--json"], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(run.stdout) as LintReport;
  } catch {
    assert.fail(`hyperframes lint did not return JSON (exit ${run.status}): ${run.stdout}\n${run.stderr}`);
  }
}

const skip = cliSkipReason();

describe("hyperframes lint on compiled compositions", { skip: skip ?? false }, () => {
  it("passes the contracts EDL fixture with zero errors and zero warnings", () => {
    const result = compile(edlFixture, styleKitFixture);
    const dir = mkdtempSync(join(tmpdir(), "meridian-lint-edl-"));
    try {
      for (const file of result.files) {
        const target = join(dir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
      // The linter checks that referenced files exist. Empty placeholders are enough for the static checks.
      for (const asset of result.assets) {
        const target = join(dir, asset.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(0));
      }
      const report = lint(dir);
      assert.equal(report.errorCount, 0, JSON.stringify(report.findings, null, 2));
      assert.equal(report.warningCount, 0, JSON.stringify(report.findings, null, 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const component of Object.values(COMPONENT_LIBRARY)) {
    for (const fixture of component.fixtures) {
      it(`passes ${component.name} / ${fixture.name} with zero errors and zero warnings`, () => {
        const built = buildHarness(component, fixture, "lint");
        try {
          const report = lint(built.dir);
          assert.equal(report.errorCount, 0, JSON.stringify(report.findings, null, 2));
          assert.equal(report.warningCount, 0, JSON.stringify(report.findings, null, 2));
        } finally {
          removeHarness(built);
        }
      });
    }
  }
});

if (skip) {
  describe("hyperframes lint on compiled compositions (skipped)", () => {
    it(`skipped: ${skip}`, { skip: true }, () => undefined);
  });
}
