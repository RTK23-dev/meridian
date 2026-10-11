import assert from "node:assert/strict";
import test from "node:test";
import { isTestingRuntimeNow } from "./runtime-mode.ts";

/** Runs `fn` with NODE_ENV and MERIDIAN_TESTING_RUNTIME set, then restores both. */
function withRuntimeEnv(nodeEnv: string | undefined, testingRuntime: string | undefined, fn: () => void) {
  const saved = { nodeEnv: process.env.NODE_ENV, testing: process.env.MERIDIAN_TESTING_RUNTIME };
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (testingRuntime === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
  else process.env.MERIDIAN_TESTING_RUNTIME = testingRuntime;
  try {
    fn();
  } finally {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.testing === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
    else process.env.MERIDIAN_TESTING_RUNTIME = saved.testing;
  }
}

test("the testing runtime is on for tests and for an explicit development switch", () => {
  withRuntimeEnv("test", undefined, () => assert.equal(isTestingRuntimeNow(), true));
  withRuntimeEnv("development", "true", () => assert.equal(isTestingRuntimeNow(), true));
});

test("a production process never runs the testing runtime, even when the switch is set", () => {
  withRuntimeEnv("production", "true", () => assert.equal(isTestingRuntimeNow(), false));
  withRuntimeEnv("production", undefined, () => assert.equal(isTestingRuntimeNow(), false));
});

test("with no switch and no test mode, the testing runtime is off", () => {
  withRuntimeEnv("development", undefined, () => assert.equal(isTestingRuntimeNow(), false));
});
