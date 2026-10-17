import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { MEDIA_FUNCTIONS_MODE_SETTING, MEDIA_FUNCTIONS_MODES, parseMediaFunctionsMode } from "./mode.ts";

describe("parseMediaFunctionsMode (the composition root's choice, read outside src/engine)", () => {
  it("is http when the setting is unset or blank, so nothing runs in-process by default", () => {
    assert.equal(parseMediaFunctionsMode(undefined), "http");
    assert.equal(parseMediaFunctionsMode(null), "http");
    assert.equal(parseMediaFunctionsMode(""), "http");
    assert.equal(parseMediaFunctionsMode("   "), "http");
  });

  it("is in_process only when the setting names it, and http when it names http", () => {
    assert.equal(parseMediaFunctionsMode("in_process"), "in_process");
    assert.equal(parseMediaFunctionsMode(" in_process "), "in_process");
    assert.equal(parseMediaFunctionsMode("http"), "http");
  });

  it("refuses any other value, so a typo never picks a mode silently", () => {
    for (const value of ["inprocess", "IN_PROCESS", "local", "true", "in-process"]) {
      assert.throws(
        () => parseMediaFunctionsMode(value),
        (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.includes(MEDIA_FUNCTIONS_MODE_SETTING),
        value,
      );
    }
  });

  it("names exactly the two modes the composition root can choose between", () => {
    assert.deepEqual([...MEDIA_FUNCTIONS_MODES], ["http", "in_process"]);
  });
});
