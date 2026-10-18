// The input checks of a shot remake (input.ts). A remake names a session, a shot of its video and an optional direction. The workspace is
// never taken from the request: the service reads it from the session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REMAKE_DIRECTIVE_MAX_CHARS } from "../../../engine/jobs/remake.ts";
import { remakeShotInput } from "./input.ts";
import { REMAKE_DIRECTION_MAX_CHARS } from "./model.ts";

const SESSION = "cf_session_1";
const SHOT = "shot_01M4T7V8BR00000000000AFP71";

test("a remake names a session, a shot of its video and an optional direction; no direction reads as none", () => {
  assert.deepEqual(remakeShotInput({ sessionId: SESSION, shotId: SHOT, directive: "close up" }), { sessionId: SESSION, shotId: SHOT, directive: "close up" });
  assert.deepEqual(remakeShotInput({ sessionId: SESSION, shotId: SHOT }), { sessionId: SESSION, shotId: SHOT, directive: null });
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
