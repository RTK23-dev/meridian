import assert from "node:assert/strict";
import test from "node:test";
import { queueTone } from "./queue-tone.ts";

test("each publishing status has one tone: published is success, processing info, failed danger, cancelled neutral", () => {
  assert.equal(queueTone("published"), "success");
  assert.equal(queueTone("processing"), "info");
  assert.equal(queueTone("failed"), "danger");
  assert.equal(queueTone("cancelled"), "neutral");
});

test("a queued status, or one not known yet, is a warning so it stands out until it settles", () => {
  assert.equal(queueTone("queued"), "warning");
  assert.equal(queueTone("something_new"), "warning");
  assert.equal(queueTone(""), "warning");
});
