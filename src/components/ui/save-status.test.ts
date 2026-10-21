import assert from "node:assert/strict";
import test from "node:test";
import { saveStateText } from "./save-status.ts";

test("each save state has its words, and an idle state has none", () => {
  assert.equal(saveStateText("saving"), "Saving");
  assert.equal(saveStateText("saved"), "Saved");
  assert.equal(saveStateText("error"), "Not saved, retry");
  assert.equal(saveStateText("idle"), "");
});
