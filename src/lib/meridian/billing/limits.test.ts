// The billing page's rules, pure: what a value may be, what unset means, and that every limit names the step it guards. The server applies the
// same parse, so a value the page refuses is refused by the store as well.

import assert from "node:assert/strict";
import { test } from "node:test";
import { centsOf, factoryCapsProblem, LIMIT_KINDS, LIMIT_SPECS, limitsFor, limitStatusText, parseLimitValue, type LimitKind } from "./limits.ts";

test("every limit has a label, a unit, bounds, what it blocks, and a scope the page can group it by", () => {
  for (const kind of LIMIT_KINDS) {
    const spec = LIMIT_SPECS[kind];
    assert.ok(spec.label.length > 0 && spec.unit.length > 0 && spec.blocks.length > 0, `${kind} is described`);
    assert.ok(spec.min < spec.max, `${kind} has bounds`);
    assert.ok(spec.scope === "workspace" || spec.scope === "brand", `${kind} has a scope`);
  }
  assert.deepEqual(limitsFor("workspace"), ["workspace_monthly_budget", "measure_ceiling", "decision_cap"]);
  assert.deepEqual(limitsFor("brand"), ["brand_budget", "factory_daily_cap", "factory_total_cap"]);
});

test("a blank value is unset for every limit except the brand budget, which must be a number: zero is the only way to stop a brand", () => {
  for (const kind of LIMIT_KINDS.filter((kind) => kind !== "brand_budget")) {
    assert.deepEqual(parseLimitValue(kind, ""), { ok: true, value: null }, `${kind} blank is unset`);
    assert.deepEqual(parseLimitValue(kind, null), { ok: true, value: null }, `${kind} null is unset`);
  }
  const blank = parseLimitValue("brand_budget", "");
  assert.equal(blank.ok, false, "a brand budget cannot be cleared into a default");
  assert.match(blank.ok ? "" : blank.message, /Enter 0 to stop all paid work/);
  assert.deepEqual(parseLimitValue("brand_budget", "0"), { ok: true, value: 0 }, "zero stops the brand's paid work");
});

test("a value must be a number in its unit, within its bounds, with no more decimal places than the unit allows", () => {
  assert.deepEqual(parseLimitValue("workspace_monthly_budget", "500.5"), { ok: true, value: 500.5 });
  assert.deepEqual(parseLimitValue("workspace_monthly_budget", 0), { ok: true, value: 0 }, "a monthly budget of zero is a real stop");
  assert.equal(parseLimitValue("workspace_monthly_budget", "12.345").ok, false, "two decimals at most");
  assert.equal(parseLimitValue("workspace_monthly_budget", "-1").ok, false);
  assert.equal(parseLimitValue("workspace_monthly_budget", "lots").ok, false);
  assert.equal(parseLimitValue("measure_ceiling", "0.009").ok, false, "a ceiling below one cent is refused");
  assert.equal(parseLimitValue("measure_ceiling", "5.01").ok, false, "a ceiling above five dollars is refused");
  assert.deepEqual(parseLimitValue("measure_ceiling", "5"), { ok: true, value: 5 }, "the top of the range is in it");
  assert.equal(parseLimitValue("measure_ceiling", "0").ok, false, "a ceiling of zero is not a value: it is unset");
  assert.equal(parseLimitValue("decision_cap", "0.0015").ok, false, "a decision cap has at most three decimal places");
  assert.deepEqual(parseLimitValue("decision_cap", "0.001"), { ok: true, value: 0.001 }, "one tenth of a cent is the least a decision may cost");
  assert.equal(parseLimitValue("decision_cap", "1.5").ok, false, "a decision cap above a dollar is refused");
  assert.equal(parseLimitValue("factory_daily_cap", "0").ok, false, "a factory cap is set above zero; unset is blank");
  assert.deepEqual(parseLimitValue("factory_total_cap", " 1000 "), { ok: true, value: 1000 }, "surrounding spaces are not a value, and the number is");
});

test("a factory cap is stored in whole cents, and the daily cap cannot be above the total cap", () => {
  assert.equal(centsOf(12.34), 1234);
  assert.equal(centsOf(0.29), 29, "0.29 rounds to 29 cents, not 28");
  assert.equal(centsOf(null), null);
  assert.equal(factoryCapsProblem(10, 50), null);
  assert.equal(factoryCapsProblem(60, 50), "The factory daily spend cap cannot be above its total cap.");
  assert.equal(factoryCapsProblem(null, 50), null, "a cap not set does not compare");
});

test("an unset limit says it refuses the step it guards; a set limit shows its value; zero shows what zero means", () => {
  assert.match(limitStatusText("workspace_monthly_budget", null), /Not set\. The step it guards is refused until you set it\./);
  assert.equal(limitStatusText("decision_cap", 0.05), "0.050 USD per call");
  assert.equal(limitStatusText("brand_budget", 0), LIMIT_SPECS.brand_budget.zeroMeans);
  const everyKind: LimitKind[] = [...LIMIT_KINDS];
  for (const kind of everyKind) assert.match(limitStatusText(kind, null), /^Not set\./, `${kind} unset reads as unset`);
});
