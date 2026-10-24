// The run policy of a Studio plan (security review, finding 1): a member cannot start a plan more automatic than the brand's default, fully
// automatic needs an admin and a brand ceiling, and no plan may ask for more than the ceiling. Pure rules, no database.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStudioRunPolicy } from "./run-policy.ts";

test("a member runs the brand's default, and may choose a stricter run", () => {
  const plain = resolveStudioRunPolicy({ role: "member", requestedAutonomy: undefined, brandAutonomy: "manual", ceilingUsd: null, requestedMaxSpendUsd: undefined });
  assert.deepEqual(plain, { ok: true, autonomy: "manual", maxSpendUsd: undefined });

  const stricter = resolveStudioRunPolicy({ role: "member", requestedAutonomy: "manual", brandAutonomy: "semi_automatic", ceilingUsd: null, requestedMaxSpendUsd: undefined });
  assert.deepEqual(stricter, { ok: true, autonomy: "manual", maxSpendUsd: undefined });
});

test("a member cannot ask for a more automatic run than the brand default, or for fully automatic at all", () => {
  const moreAutomatic = resolveStudioRunPolicy({ role: "member", requestedAutonomy: "semi_automatic", brandAutonomy: "manual", ceilingUsd: null, requestedMaxSpendUsd: undefined });
  assert.equal(moreAutomatic.ok, false);

  const fully = resolveStudioRunPolicy({ role: "member", requestedAutonomy: "fully_automatic", brandAutonomy: "fully_automatic", ceilingUsd: 50, requestedMaxSpendUsd: undefined });
  assert.equal(fully.ok, false);
});

test("fully automatic needs an admin and a brand-set ceiling", () => {
  const noCeiling = resolveStudioRunPolicy({ role: "admin", requestedAutonomy: "fully_automatic", brandAutonomy: "manual", ceilingUsd: null, requestedMaxSpendUsd: undefined });
  assert.equal(noCeiling.ok, false);

  const withCeiling = resolveStudioRunPolicy({ role: "admin", requestedAutonomy: undefined, brandAutonomy: "fully_automatic", ceilingUsd: 50, requestedMaxSpendUsd: undefined });
  assert.deepEqual(withCeiling, { ok: true, autonomy: "fully_automatic", maxSpendUsd: 50 });
});

test("no plan asks for more than the brand ceiling, and a smaller cap is kept", () => {
  const over = resolveStudioRunPolicy({ role: "admin", requestedAutonomy: undefined, brandAutonomy: "manual", ceilingUsd: 50, requestedMaxSpendUsd: 80 });
  assert.equal(over.ok, false);

  const under = resolveStudioRunPolicy({ role: "member", requestedAutonomy: undefined, brandAutonomy: "manual", ceilingUsd: 50, requestedMaxSpendUsd: 5 });
  assert.deepEqual(under, { ok: true, autonomy: "manual", maxSpendUsd: 5 });
});
