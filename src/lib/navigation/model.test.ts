import assert from "node:assert/strict";
import test from "node:test";
import { sidebarGroups, switcherMode } from "./model.ts";

function itemIds(groups: ReturnType<typeof sidebarGroups>, groupId: string): string[] {
  return groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? [];
}

test("the brand sidebar keeps Factory under Create and Calibration under Learn", () => {
  const groups = sidebarGroups({ brandId: "b1", reviewCount: null });
  assert.ok(itemIds(groups, "create").includes("factory"), "Factory is in the Create workflow group");
  assert.ok(itemIds(groups, "learn").includes("calibration"), "Calibration is in the Learn workflow group");
  const factory = groups.flatMap((group) => group.items).find((item) => item.id === "factory");
  assert.equal(factory?.to, "/brands/b1/factory", "Factory links to the brand's factory screen");
  const calibration = groups.flatMap((group) => group.items).find((item) => item.id === "calibration");
  assert.equal(calibration?.to, "/brands/b1/calibration");
});

test("connected accounts sit in the brand group, and notification preferences stay in the workspace group", () => {
  const groups = sidebarGroups({ brandId: "b1", reviewCount: null });
  assert.ok(itemIds(groups, "brand").includes("accounts"));
  assert.equal(groups.flatMap((group) => group.items).find((item) => item.id === "accounts")?.to, "/brands/b1/accounts");
  assert.ok(itemIds(groups, "workspace").includes("notifications"), "notification preferences remain reachable from the sidebar");
});

test("workspace pages show no brand groups", () => {
  const groups = sidebarGroups({ reviewCount: null });
  assert.deepEqual(groups.map((group) => group.id), ["overview", "workspace"]);
  assert.ok(itemIds(groups, "workspace").includes("integrations"));
});

test("the collapsed rail keeps a switcher, and the expanded sidebar and mobile sheet keep the selects", () => {
  assert.equal(switcherMode({ collapsed: true, mobile: false }), "rail-button", "the rail is too narrow for a select, so it keeps a button");
  assert.equal(switcherMode({ collapsed: false, mobile: false }), "selects");
  assert.equal(switcherMode({ collapsed: true, mobile: true }), "selects", "the mobile sheet is never collapsed");
  assert.equal(switcherMode({ collapsed: false, mobile: true }), "selects");
});
