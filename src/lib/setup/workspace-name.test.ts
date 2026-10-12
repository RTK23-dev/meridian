import assert from "node:assert/strict";
import test from "node:test";
import { suggestedWorkspaceName } from "./workspace-name.ts";

test("the suggestion uses the first name and the workspace word", () => {
  assert.equal(suggestedWorkspaceName("Ada Lovelace"), "Ada's workspace");
  assert.equal(suggestedWorkspaceName("  Grace  "), "Grace's workspace");
});

test("a missing or blank name gets a neutral suggestion", () => {
  assert.equal(suggestedWorkspaceName(null), "My workspace");
  assert.equal(suggestedWorkspaceName(undefined), "My workspace");
  assert.equal(suggestedWorkspaceName("   "), "My workspace");
});

test("a very long first name is capped at the workspace name limit", () => {
  const suggestion = suggestedWorkspaceName("A".repeat(200));
  assert.equal(suggestion.length, 80);
});

test("an email address in place of a name gets the neutral suggestion", () => {
  assert.equal(suggestedWorkspaceName("ada@example.com"), "My workspace");
});
