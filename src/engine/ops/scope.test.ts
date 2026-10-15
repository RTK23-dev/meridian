// The workspace scope of an operations read (AGENTS.md rule 2): validated, never widened. The stored JSON reader treats bad text as unknown.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { parseJsonRecord } from "./json.ts";
import { MAX_SCOPE_WORKSPACES, scopeIds, scopeParam } from "./scope.ts";

const invalidInput = (error: unknown): boolean => error instanceof EngineError && error.kind === "invalid_input";

describe("operations scope", () => {
  test("the workspaces are de-duplicated and sorted, and passed as one JSON text", () => {
    assert.deepEqual(scopeIds({ organizationIds: ["ws_b", "ws_a", "ws_b"] }), ["ws_a", "ws_b"]);
    assert.equal(scopeParam({ organizationIds: ["ws_b", "ws_a"] }), '["ws_a","ws_b"]');
  });

  test("an empty scope, a blank id and a scope over the maximum are refused, never widened to every workspace", () => {
    assert.throws(() => scopeIds({ organizationIds: [] }), invalidInput);
    assert.throws(() => scopeIds({ organizationIds: ["ws_a", "  "] }), invalidInput);
    assert.throws(() => scopeIds({ organizationIds: Array.from({ length: MAX_SCOPE_WORKSPACES + 1 }, (_, index) => `ws_${index}`) }), invalidInput);
  });

  test("a stored JSON text reads as an object, or as unknown when it is not one", () => {
    assert.deepEqual(parseJsonRecord('{"a":1}'), { a: 1 });
    assert.equal(parseJsonRecord("[1]"), null);
    assert.equal(parseJsonRecord("null"), null);
    assert.equal(parseJsonRecord("{not json"), null);
  });
});
