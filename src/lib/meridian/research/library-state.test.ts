import assert from "node:assert/strict";
import test from "node:test";
import { libraryStateFor } from "./library-state.ts";

const reason = "No Meta Ad Library key is saved for this workspace.";

test("without a usable key the library is not connected, and the resolver's reason is shown", () => {
  assert.deepEqual(
    libraryStateFor({ keySecret: null, keyReason: reason, storedStatus: "CONNECTED", storedError: "" }),
    { status: "NOT_CONNECTED", connectionError: reason },
    "a status stored by an earlier run never shows a connection the workspace no longer has",
  );
});

test("with a key, a stored NOT_CONNECTED from a run before the key was saved does not stick", () => {
  assert.deepEqual(
    libraryStateFor({ keySecret: "k", keyReason: "", storedStatus: "NOT_CONNECTED", storedError: reason }),
    { status: "AVAILABLE", connectionError: "" },
  );
});

test("with a key and a collection that ran, its stored status and error are shown", () => {
  assert.deepEqual(
    libraryStateFor({ keySecret: "k", keyReason: "", storedStatus: "CONNECTED", storedError: "" }),
    { status: "CONNECTED", connectionError: "" },
  );
  assert.deepEqual(
    libraryStateFor({ keySecret: "k", keyReason: "", storedStatus: "failed", storedError: "Meta rate limit" }),
    { status: "failed", connectionError: "Meta rate limit" },
  );
});

test("with a key and no collection yet, the library is available, not connected", () => {
  assert.deepEqual(
    libraryStateFor({ keySecret: "k", keyReason: "", storedStatus: "", storedError: "" }),
    { status: "AVAILABLE", connectionError: "" },
  );
});
