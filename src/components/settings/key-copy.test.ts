import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOwnerNote, splitOperatorHint } from "./key-copy.ts";

test("the environment variable is moved out of the plain sentence", () => {
  const split = splitOperatorHint("This workspace has no saved YouTube credential, and the deployment does not share one. Set YOUTUBE_API_KEY=key to use the deployment key.");
  assert.doesNotMatch(split.plain, /YOUTUBE_API_KEY/);
  assert.match(split.plain, /no saved YouTube credential/);
  assert.match(split.operator ?? "", /YOUTUBE_API_KEY=key/);
});

test("a reason without an operator hint is unchanged", () => {
  assert.deepEqual(splitOperatorHint("A key is saved."), { plain: "A key is saved.", operator: null });
});

test("the key note says whose key it is and that the studied brand's login is never needed", () => {
  const note = keyOwnerNote("YouTube");
  assert.match(note, /your own developer key/);
  assert.match(note, /never needs a password or token from any brand you study/);
});

test("a shared-default reason keeps the variable name out of the plain text", () => {
  const split = splitOperatorHint("The deployment's key is saved and can be read, because YOUTUBE_SHARED_DEFAULT=deployment is set. This workspace has no key of its own.");
  assert.doesNotMatch(split.plain, /[A-Z]+_SHARED_DEFAULT/);
  assert.match(split.plain, /This workspace has no key of its own/);
  assert.match(split.operator ?? "", /YOUTUBE_SHARED_DEFAULT=deployment is set/);
});
