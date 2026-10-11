import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_LIST_LIMIT, APP_NAME, bottomTabs, brandIdFromPath, documentTitle, isCurrentPath, isForbiddenError,
  resolveLastBrand, sidebarGroups, unreadAlertLabel,
} from "./model.ts";

test("brandIdFromPath reads the brand from brand paths and never from /brands/new", () => {
  assert.equal(brandIdFromPath("/brands/brand-1"), "brand-1");
  assert.equal(brandIdFromPath("/brands/brand-1/studio"), "brand-1");
  assert.equal(brandIdFromPath("/brands/new"), undefined, "the create page is not a brand");
  assert.equal(brandIdFromPath("/brands/new/studio"), undefined);
  assert.equal(brandIdFromPath("/brands"), undefined);
  assert.equal(brandIdFromPath("/jobs"), undefined);
  assert.equal(brandIdFromPath("/"), undefined);
});

test("workspace pages list the workspace groups in order and no brand groups", () => {
  const groups = sidebarGroups({ reviewCount: 4 });
  assert.deepEqual(groups.map((group) => group.id), ["overview", "workspace"]);
  assert.deepEqual(groups[1]?.items.map((item) => item.id), ["jobs", "usage", "alerts", "integrations", "settings", "audit", "exports", "webhooks", "notifications"]);
  for (const group of groups) {
    for (const item of group.items) assert.equal(item.to.startsWith("/brands/"), false, `${item.id} must not be a brand link off brand pages`);
  }
});

test("brand pages list the brand groups in workflow order, with the workspace group last", () => {
  const groups = sidebarGroups({ brandId: "brand-1", reviewCount: null });
  assert.deepEqual(groups.map((group) => group.id), ["overview", "research", "decide", "create", "learn", "brand", "workspace"]);
  const brandItems = groups.slice(0, -1).flatMap((group) => group.items);
  for (const item of brandItems) assert.equal(item.to === "/brands/brand-1" || item.to.startsWith("/brands/brand-1/"), true, item.to);
});

test("a review badge appears only for a real count above zero", () => {
  const badgeOf = (reviewCount: number | null) => sidebarGroups({ brandId: "b", reviewCount })
    .flatMap((group) => group.items).find((item) => item.id === "reviews")?.badge;
  assert.equal(badgeOf(null), undefined, "a count that has not loaded shows no badge");
  assert.equal(badgeOf(0), undefined, "zero shows no badge");
  assert.equal(badgeOf(3), 3);
});

test("the review badge is absent on workspace pages", () => {
  const items = sidebarGroups({ reviewCount: 5 }).flatMap((group) => group.items);
  assert.equal(items.some((item) => item.id === "reviews"), false);
});

test("bottom tabs are the workspace four off brand pages and the brand four on them", () => {
  assert.deepEqual(bottomTabs().map((tab) => tab.to), ["/", "/alerts", "/integrations", "/settings"]);
  assert.deepEqual(bottomTabs("brand-1").map((tab) => tab.to), ["/brands/brand-1", "/brands/brand-1/opportunities", "/brands/brand-1/studio", "/brands/brand-1/reviews"]);
});

test("a trailing slash is the same page, and other paths are not", () => {
  assert.equal(isCurrentPath("/brands/b1/", "/brands/b1"), true);
  assert.equal(isCurrentPath("/brands/b1", "/brands/b1/"), true);
  assert.equal(isCurrentPath("/", "/"), true);
  assert.equal(isCurrentPath("/x//", "/x"), true);
  assert.equal(isCurrentPath("/brands/b1/studio", "/brands/b1"), false);
  assert.equal(isCurrentPath("/brands/b10", "/brands/b1"), false, "a shared prefix is a different page");
});

test("the document title is page, brand, then the app name, with empty parts dropped", () => {
  assert.equal(APP_NAME, "Meridian");
  assert.equal(documentTitle({ page: "Studio", brandName: "Brand" }), "Studio · Brand · Meridian");
  assert.equal(documentTitle({ page: "Jobs" }), "Jobs · Meridian");
  assert.equal(documentTitle({ brandName: "Brand" }), "Brand · Meridian");
  assert.equal(documentTitle({ page: "", brandName: "  " }), "Meridian");
  assert.equal(documentTitle({}), "Meridian");
  assert.equal(documentTitle({ page: "  Studio  ", brandName: " Brand " }), "Studio · Brand · Meridian", "padding is not shown in the title");
});

test("a 403 status or a permission message is forbidden, and other errors are not", () => {
  assert.equal(isForbiddenError({ status: 403 }), true);
  assert.equal(isForbiddenError(new Error("You do not have permission to view this brand.")), true);
  assert.equal(isForbiddenError("Forbidden"), true);
  assert.equal(isForbiddenError(new Error("forbidden origin")), true);
  assert.equal(isForbiddenError({ status: 500 }), false);
  assert.equal(isForbiddenError({ status: "403" }), false, "the status must be the number 403");
  assert.equal(isForbiddenError(new Error("network down")), false);
  assert.equal(isForbiddenError(null), false);
  assert.equal(isForbiddenError(undefined), false);
});

test("the alert bell shows nothing for no unread alerts and marks a capped list with a plus", () => {
  assert.equal(unreadAlertLabel([]), null);
  assert.equal(unreadAlertLabel([{ acknowledged: true }]), null);
  assert.equal(unreadAlertLabel([{ acknowledged: false }, { acknowledged: false }, { acknowledged: true }]), "2");
  const full = Array.from({ length: ALERT_LIST_LIMIT }, (_, index) => ({ acknowledged: index < 3 }));
  assert.equal(unreadAlertLabel(full), `${ALERT_LIST_LIMIT - 3}+`, "a full list may hide more unread alerts");
  const fullRead = Array.from({ length: ALERT_LIST_LIMIT }, () => ({ acknowledged: true }));
  assert.equal(unreadAlertLabel(fullRead), null);
});

test("the remembered brand is kept only while it belongs to the active workspace", () => {
  assert.equal(resolveLastBrand("b1", ["b1", "b2"]), "b1");
  assert.equal(resolveLastBrand("gone", ["b1", "b2"]), null);
  assert.equal(resolveLastBrand("b1", []), null);
  assert.equal(resolveLastBrand("", ["b1"]), null);
  assert.equal(resolveLastBrand(null, ["b1"]), null);
});
