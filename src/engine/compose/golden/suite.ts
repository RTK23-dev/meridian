// The golden-frame suite (Bible 17.3). Two entry files run it: golden.run.ts compares (npm run engine:golden), and
// golden.update.ts writes the PNGs again (npm run engine:golden:update). The mode is passed in, not read from the
// environment, so this module reads no environment variables.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMPONENT_LIBRARY } from "../components/index.ts";
import {
  buildHarness,
  comparePng,
  extractFrame,
  goldenPath,
  removeHarness,
  renderHarnessLocally,
} from "./harness.ts";

const RENDER_TIMEOUT_MS = 900_000;

/** Register one test per component fixture. update=true writes each frame as the new golden PNG instead of comparing. */
export function goldenSuite(update: boolean): void {
  describe(
    update
      ? "component golden frames: writing the PNGs again (review each one by eye)"
      : "component golden frames (local HyperFrames render, pixel diff under 1%)",
    () => {
      for (const component of Object.values(COMPONENT_LIBRARY)) {
        describe(component.name, () => {
          for (const fixture of component.fixtures) {
            it(`${fixture.name} ${update ? "is written" : "matches its golden frames"}`, { timeout: RENDER_TIMEOUT_MS }, () => {
              const built = buildHarness(component, fixture);
              const work = mkdtempSync(join(tmpdir(), "meridian-golden-frames-"));
              try {
                const rendered = renderHarnessLocally(built);
                assert.ok(rendered.ok, rendered.ok ? "" : rendered.reason);
                for (const frameMs of fixture.framesMs) {
                  const actual = extractFrame(rendered.mp4, frameMs, work);
                  const golden = goldenPath(component, fixture, frameMs);
                  if (update) {
                    mkdirSync(dirname(golden), { recursive: true });
                    writeFileSync(golden, actual);
                    continue;
                  }
                  assert.ok(
                    existsSync(golden),
                    `missing golden frame ${golden}; run npm run engine:golden:update and review the PNG`,
                  );
                  const result = comparePng(actual, readFileSync(golden));
                  assert.ok(
                    result.pass,
                    `${component.name} ${fixture.name} at ${frameMs} ms: ${(result.diffRatio * 100).toFixed(3)}% of pixels differ` +
                      (result.reason ? ` (${result.reason})` : ""),
                  );
                }
              } finally {
                rmSync(work, { recursive: true, force: true });
                removeHarness(built);
              }
            });
          }
        });
      }
    },
  );
}
