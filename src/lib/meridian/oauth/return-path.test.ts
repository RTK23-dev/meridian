import assert from "node:assert/strict";
import test from "node:test";
import { oauthReturnPath } from "./return-path.ts";

test("OAuth returns only to Integrations or a brand's accounts page", () => {
  assert.equal(oauthReturnPath("/integrations"), "/integrations");
  assert.equal(oauthReturnPath("/brands/brand-1/accounts"), "/brands/brand-1/accounts");
  assert.equal(oauthReturnPath("https://evil.example/integrations"), "/integrations");
  assert.equal(oauthReturnPath("/brands/brand-1/accounts?next=/admin"), "/integrations");
  assert.equal(oauthReturnPath("/brands/../accounts"), "/integrations");
  assert.equal(oauthReturnPath(""), "/integrations");
  assert.equal(oauthReturnPath(undefined), "/integrations");
});
