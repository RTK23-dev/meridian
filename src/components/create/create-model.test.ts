import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_ACCEPT, CREATE_MODE_COPY, CREATE_SUGGESTIONS, fileProblem, purposeFor, ruleFor, sendBlock, titleFor } from "./create-model.ts";
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


test("a picked file is checked against the server's own rules: its type, then its extension for a text file", () => {
  assert.equal(ruleFor({ type: "video/mp4", name: "clip.mp4" })?.kind, "video");
  assert.equal(ruleFor({ type: "", name: "notes.md" })?.kind, "text", "a Markdown file with no type is still text");
  assert.equal(ruleFor({ type: "application/zip", name: "archive.zip" }), null);
  assert.match(CREATE_ACCEPT, /video\/mp4/);
  assert.match(CREATE_ACCEPT, /\.json/);
});

test("a file over its limit is refused by name, and a file within it is not", () => {
  assert.equal(fileProblem({ type: "video/mp4", name: "ok.mp4", size: 39_000_000 }), null);
  assert.match(fileProblem({ type: "video/mp4", name: "big.mp4", size: 41_000_000 }) ?? "", /big\.mp4 is larger than 40 MB/);
  assert.match(fileProblem({ type: "image/png", name: "shot.png", size: 11_000_000 }) ?? "", /10 MB/);
  assert.match(fileProblem({ type: "application/zip", name: "a.zip", size: 1 }) ?? "", /not a type Meridian takes/);
});

test("a video is a reference, and anything else is material", () => {
  assert.equal(purposeFor({ type: "video/quicktime" }), "reference_video");
  assert.equal(purposeFor({ type: "image/png" }), "material");
  assert.equal(purposeFor({ type: "" }), "material");
});
