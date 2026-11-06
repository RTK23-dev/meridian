import assert from "node:assert/strict";
import test from "node:test";
import { REGISTER_FOR_FEELING, registerForFeeling } from "../../../engine/compose/motion/registers.ts";
import { EMOTION_IDS } from "./codex.ts";

test("every feeling the codex can choose suggests a motion register, so a script's feeling can set how its video moves", () => {
  assert.deepEqual(Object.keys(REGISTER_FOR_FEELING).sort(), [...EMOTION_IDS].sort());
  for (const feeling of EMOTION_IDS) assert.ok(registerForFeeling(feeling));
  assert.equal(registerForFeeling("awe"), "premium");
});
