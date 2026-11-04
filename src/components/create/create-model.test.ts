import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_MODE_COPY, CREATE_SUGGESTIONS, sendBlock, titleFor } from "./create-model.ts";
import { MAX_MESSAGE_CHARS } from "../../lib/meridian/content-factory/model.ts";

const ready = { text: "A 30-second video for my new mug", mode: "orchestrator" as const, canAdmin: true, busy: false };

test("a message can be sent in Orchestrator mode by an admin, when it has words", () => {
  assert.equal(sendBlock(ready), null);
});

test("Studio never sends text: it says where the controls are", () => {
  const reason = sendBlock({ ...ready, mode: "studio" });
  assert.match(reason ?? "", /controls on this page/);
});

test("a non-admin is told why nothing is sent, and a busy page says so", () => {
  assert.equal(sendBlock({ ...ready, canAdmin: false }), "Only a workspace admin can start a draft.");
  assert.equal(sendBlock({ ...ready, busy: true }), "Sending.");
});

test("an empty or blank message asks for what to make, and a long one says the limit", () => {
  assert.equal(sendBlock({ ...ready, text: "   " }), "Write what you want to make.");
  assert.match(sendBlock({ ...ready, text: "x".repeat(MAX_MESSAGE_CHARS + 1) }) ?? "", new RegExp(`${MAX_MESSAGE_CHARS} characters`));
});

test("a draft is named after the first line of the message, shortened when it is long", () => {
  assert.equal(titleFor("  Make   a mug video\nwith music  "), "Make a mug video");
  assert.equal(titleFor(""), "New draft");
  assert.equal(titleFor("x".repeat(200)).length, 80);
});

test("each mode has a label and a one-line hint, and the page offers three starting points", () => {
  assert.equal(CREATE_MODE_COPY.orchestrator.label, "Orchestrator");
  assert.equal(CREATE_MODE_COPY.studio.label, "Studio");
  assert.equal(CREATE_SUGGESTIONS.length, 3);
});
