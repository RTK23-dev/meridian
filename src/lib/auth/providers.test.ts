import assert from "node:assert/strict";
import test from "node:test";
import { SIGN_IN_PROVIDERS } from "./providers.ts";

test("the only provider offered besides email and password is Google", () => {
  assert.deepEqual(
    SIGN_IN_PROVIDERS.map((provider) => provider.id),
    ["google"],
  );
  assert.equal(SIGN_IN_PROVIDERS[0]?.label, "Google");
});
