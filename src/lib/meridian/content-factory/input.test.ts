// The input checks of a shot remake (input.ts). A remake names a session, a shot of its video and an optional direction. The workspace is
// never taken from the request: the service reads it from the session.
import { clipInput, shotDecisionInput } from "./input.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REMAKE_DIRECTIVE_MAX_CHARS } from "../../../engine/jobs/remake.ts";
import { remakeShotInput } from "./input.ts";
import { REMAKE_DIRECTION_MAX_CHARS } from "./model.ts";

const SESSION = "cf_session_1";
const SHOT = "shot_01M4T7V8BR00000000000AFP71";

test("a remake names a session, a shot of its video and an optional direction; no direction reads as none", () => {
  assert.deepEqual(remakeShotInput({ sessionId: SESSION, shotId: SHOT, directive: "close up" }), { sessionId: SESSION, shotId: SHOT, directive: "close up", modelId: null });
  assert.deepEqual(remakeShotInput({ sessionId: SESSION, shotId: SHOT }), { sessionId: SESSION, shotId: SHOT, directive: null, modelId: null });
  assert.deepEqual(remakeShotInput({ sessionId: SESSION, shotId: SHOT, modelId: " seedance-2.0-mini " }).modelId, "seedance-2.0-mini", "a picked model is kept by its id");
  assert.throws(() => remakeShotInput({ sessionId: SESSION, shotId: SHOT, modelId: 7 }), /Choose a model/);
});

test("the id named must be a shot id", () => {
  assert.throws(() => remakeShotInput({ sessionId: SESSION, shotId: "take_01M4T7V8BR00000000000AFP71" }), /Choose a shot/);
  assert.throws(() => remakeShotInput({ sessionId: SESSION, shotId: "" }), /Choose a valid shot/);
});

test("a direction longer than the limit is refused, and one at the limit is kept", () => {
  assert.throws(() => remakeShotInput({ sessionId: SESSION, shotId: SHOT, directive: "x".repeat(REMAKE_DIRECTION_MAX_CHARS + 1) }), /characters/);
  assert.equal(remakeShotInput({ sessionId: SESSION, shotId: SHOT, directive: "x".repeat(REMAKE_DIRECTION_MAX_CHARS) }).directive?.length, REMAKE_DIRECTION_MAX_CHARS);
});

test("the workspace is never read from the request", () => {
  const parsed = remakeShotInput({ sessionId: SESSION, shotId: SHOT, organizationId: "org_someone_else" });
  assert.equal("organizationId" in parsed, false);
});

test("the screen's direction limit is the engine's limit", () => {
  assert.equal(REMAKE_DIRECTION_MAX_CHARS, REMAKE_DIRECTIVE_MAX_CHARS);
});

test("a shot decision is checked before it is read: an action the engine does not take, or a shot that is not a shot, is refused", () => {
  const ok = shotDecisionInput({ sessionId: "session_abc123", shotId: "shot_01M4T7V8BR00000000000AFP71", decision: { action: "edit_prompt", prompt: "Dawn" } });
  assert.equal(ok.decision.action, "edit_prompt");
  assert.throws(() => shotDecisionInput({ sessionId: "session_abc123", shotId: "shot_01M4T7V8BR00000000000AFP71", decision: { action: "delete_video" } }));
  assert.throws(() => shotDecisionInput({ sessionId: "session_abc123", shotId: "take_1", decision: { action: "edit_prompt", prompt: "x" } }), /Choose a shot/);
});

test("a clip is checked before it is read: a shot of this video, a file within the upload limit, and base64 only", () => {
  const ok = clipInput({ sessionId: "session_abc123", shotId: "shot_01M4T7V8BR00000000000AFP71", base64: "AAAA" });
  assert.equal(ok.base64, "AAAA");
  assert.throws(() => clipInput({ sessionId: "session_abc123", shotId: "shot_01M4T7V8BR00000000000AFP71", base64: "" }), /Choose a clip/);
  assert.throws(() => clipInput({ sessionId: "session_abc123", shotId: "shot_01M4T7V8BR00000000000AFP71", base64: "not base64!" }), /could not be read/);
  assert.throws(() => clipInput({ sessionId: "session_abc123", shotId: "take_1", base64: "AAAA" }), /Choose a shot/);
});
