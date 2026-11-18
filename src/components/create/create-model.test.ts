import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_ACCEPT, CREATE_MODE_COPY, CREATE_PLACEHOLDER, CREATE_SUGGESTIONS, CREATE_WAY_COPY, CREATE_WAYS, createSearchOf, defaultWay, textModelStateOf, wayOf, fileProblem, purposeFor, referencePurposeOf, ruleFor, sendBlock, titleFor, togglePurposeOf } from "./create-model.ts";
import { MAX_MESSAGE_CHARS } from "../../lib/meridian/content-factory/model.ts";

const ready = { text: "A 30-second video for my new mug", mode: "orchestrator" as const, canAdmin: true, busy: false };

test("a message can be sent in Orchestrator mode by an admin, when it has words", () => {
  assert.equal(sendBlock(ready), null);
});

test("Studio takes a typed request like Orchestrator, with its own placeholder", () => {
  assert.equal(sendBlock({ ...ready, mode: "studio" }), null);
  assert.match(CREATE_PLACEHOLDER.studio, /you set each step/);
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
  assert.equal(CREATE_MODE_COPY.orchestrator.label, "Meridian plans it");
  assert.equal(CREATE_MODE_COPY.studio.label, "I set each step");
  assert.equal(CREATE_SUGGESTIONS.length, 3);
});

test("the front door offers three plain ways, in order: free with Claude Code, with Meridian, and many variations", () => {
  assert.deepEqual([...CREATE_WAYS], ["claude_code", "meridian", "batch"]);
  assert.equal(CREATE_WAY_COPY.claude_code.label, "Free, with Claude Code on your computer");
  assert.equal(CREATE_WAY_COPY.meridian.label, "With Meridian (uses your keys)");
  assert.equal(CREATE_WAY_COPY.batch.label, "Many variations at once");
});

test("a remembered way is read back only when it is one of the ways", () => {
  assert.equal(wayOf("batch"), "batch");
  assert.equal(wayOf("orchestrator"), null);
  assert.equal(wayOf(null), null);
});

test("the OpenRouter key's state decides whether a text model is available, and a failed read is unknown", () => {
  assert.equal(textModelStateOf({ loading: true, failed: false, credentialState: undefined }), "loading");
  assert.equal(textModelStateOf({ loading: false, failed: false, credentialState: "usable" }), "available");
  assert.equal(textModelStateOf({ loading: false, failed: false, credentialState: "not_configured" }), "missing");
  assert.equal(textModelStateOf({ loading: false, failed: false, credentialState: "unusable" }), "missing");
  assert.equal(textModelStateOf({ loading: false, failed: false, credentialState: undefined }), "unknown");
  assert.equal(textModelStateOf({ loading: false, failed: true, credentialState: undefined }), "unknown");
});

test("the page opens on Claude Code without a text model, on Meridian with one or when it cannot tell, and a remembered choice wins", () => {
  assert.equal(defaultWay({ stored: null, textModel: "missing" }), "claude_code");
  assert.equal(defaultWay({ stored: null, textModel: "available" }), "meridian");
  assert.equal(defaultWay({ stored: null, textModel: "unknown" }), "meridian", "an unknown state does not guess the free way");
  assert.equal(defaultWay({ stored: null, textModel: "loading" }), null, "nothing is chosen while the key state loads");
  assert.equal(defaultWay({ stored: "batch", textModel: "missing" }), "batch");
  assert.equal(defaultWay({ stored: "nonsense", textModel: "available" }), "meridian");
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

test("a video can be the reference video and a picture a reference image; text and PDFs stay material", () => {
  assert.equal(referencePurposeOf("video"), "reference_video");
  assert.equal(referencePurposeOf("image"), "reference_image");
  assert.equal(referencePurposeOf("text"), null);
  assert.equal(togglePurposeOf("image", "material"), "reference_image");
  assert.equal(togglePurposeOf("image", "reference_image"), "material");
  assert.equal(togglePurposeOf("video", "material"), "reference_video");
  assert.equal(togglePurposeOf("document", "material"), "material", "a PDF has no reference to switch to");
});

test("the address reopens a draft by its id, and ignores anything else", () => {
  assert.deepEqual(createSearchOf({ draft: "3f2a-41" }), { draft: "3f2a-41" });
  assert.deepEqual(createSearchOf({ draft: "../x" }), {});
  assert.deepEqual(createSearchOf({ draft: 4, other: "y" }), {});
  assert.deepEqual(createSearchOf({}), {});
});

test("the address can open the empty page on one way, and ignores a way that is not one", () => {
  assert.deepEqual(createSearchOf({ way: "claude_code" }), { way: "claude_code" });
  assert.deepEqual(createSearchOf({ way: "studio" }), {});
  assert.deepEqual(createSearchOf({ draft: "d1", way: "meridian" }), { draft: "d1", way: "meridian" });
});
