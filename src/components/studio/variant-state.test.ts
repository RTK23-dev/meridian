import assert from "node:assert/strict";
import test from "node:test";
import { hasStoredFile } from "./variant-state.ts";

test("only a stored asset row counts as a stored file", () => {
  assert.equal(hasStoredFile({ assetStatus: "stored" }), true);
  assert.equal(hasStoredFile({ assetStatus: " Stored " }), true);
  assert.equal(hasStoredFile({ assetStatus: "unavailable" }), false);
  assert.equal(hasStoredFile({ assetStatus: "" }), false);
});
