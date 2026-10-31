import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_LIST_LIMIT, APP_NAME, AREA_GUIDE, bottomTabs, brandIdFromPath, documentTitle, isCurrentPath, isForbiddenError,
  nextStep, paletteScreens, resolveLastBrand, SETTINGS_SCREEN_LINKS, sidebarGroups, switcherMode, unreadAlertLabel,
} from "./model.ts";

test("the brand overview's area guide links only to screens the sidebar lists, so it cannot point at a missing screen", () => {
  const listed = new Set(sidebarGroups({ brandId: "brand-1", reviewCount: 0 }).flatMap((group) => group.items.map((item) => item.to)));
  for (const area of AREA_GUIDE) {
    assert.equal(listed.has(`/brands/brand-1/${area.path}`), true, `${area.id} is in the sidebar`);
    assert.notEqual(area.what.trim(), "", `${area.id} says what it is for`);
  }
  assert.equal(new Set(AREA_GUIDE.map((area) => area.path)).size, AREA_GUIDE.length, "each screen is listed once");
});

test("brandIdFromPath reads the brand from brand paths and never from /brands/new", () => {
  assert.equal(brandIdFromPath("/brands/brand-1"), "brand-1");
  assert.equal(brandIdFromPath("/brands/brand-1/studio"), "brand-1");
  assert.equal(brandIdFromPath("/brands/new"), undefined, "the create page is not a brand");
  assert.equal(brandIdFromPath("/brands/new/studio"), undefined);
  assert.equal(brandIdFromPath("/brands"), undefined);
  assert.equal(brandIdFromPath("/jobs"), undefined);
  assert.equal(brandIdFromPath("/"), undefined);
});

test("workspace pages list the workspace overview and the Settings group, and no brand groups", () => {
  const groups = sidebarGroups({ reviewCount: 4 });
  assert.deepEqual(groups.map((group) => group.id), ["overview", "settings"]);
  assert.deepEqual(groups[0]?.items.map((item) => item.to), ["/", "/content-factory"], "Content is a workspace screen");
  assert.deepEqual(groups[1]?.items.map((item) => item.id), ["setup", "integrations", "jobs", "engine-ops", "settings"]);
  for (const group of groups) {
    for (const item of group.items) assert.equal(item.to.startsWith("/brands/"), false, `${item.id} must not be a brand link off brand pages`);
  }
});

test("brand pages list the brand groups in the order Brand, Research, Content, Results, then Settings", () => {
  const groups = sidebarGroups({ brandId: "brand-1", reviewCount: null });
  assert.deepEqual(groups.map((group) => group.id), ["brand", "research", "content", "results", "settings"]);
  const brandItems = groups.slice(0, -1).flatMap((group) => group.items);
  for (const item of brandItems) assert.equal(item.to === "/brands/brand-1" || item.to.startsWith("/brands/brand-1/"), true, item.to);
  const settingsItems = groups[groups.length - 1]?.items ?? [];
  for (const item of settingsItems) assert.equal(item.to.startsWith("/brands/"), false, `${item.id} is workspace-level and shows on every page`);
});

test("the sidebar shows the core loop and no longer lists the six screens that moved under Settings", () => {
  const moved = ["usage", "alerts", "audit", "webhooks", "exports", "notifications"];
  for (const brandId of [undefined, "brand-1"]) {
    const ids = sidebarGroups({ brandId, reviewCount: null }).flatMap((group) => group.items.map((item) => item.id));
    for (const id of moved) assert.equal(ids.includes(id), false, `${id} must not be in the sidebar`);
  }
  const brandIds = sidebarGroups({ brandId: "brand-1", reviewCount: null }).flatMap((group) => group.items.map((item) => item.id));
  assert.equal(brandIds.length, 12, "7 brand screens and 5 settings screens");
});

test("the Settings screen lists every screen that moved out of the sidebar, with its route", () => {
  assert.deepEqual(SETTINGS_SCREEN_LINKS.map((link) => link.to), ["/usage", "/alerts", "/audit", "/webhooks", "/exports", "/notifications"]);
  assert.deepEqual(SETTINGS_SCREEN_LINKS.map((link) => link.label), ["Usage & cost", "Alerts center", "Audit log", "Webhook events", "Exports", "Notification preferences"], "labels are accessible names, so they must not change");
});

test("every brand screen except the overview names a next step that is also in the sidebar", () => {
  const brandId = "brand-1";
  const groups = sidebarGroups({ brandId, reviewCount: null });
  const brandItems = groups.slice(0, -1).flatMap((group) => group.items);
  const sidebarTargets = new Set(groups.flatMap((group) => group.items.map((item) => item.to)));
  for (const item of brandItems) {
    if (item.id === "brand-overview") continue;
    const next = nextStep({ pathname: item.to, brandId });
    assert.ok(next, `${item.id} needs a next step`);
    assert.ok(sidebarTargets.has(next.to), `${item.id} links to ${next.to}, which is not in the sidebar`);
    assert.notEqual(next.to, item.to, `${item.id} must not link to itself`);
  }
});

test("the brand overview has no footer next step, because its own next-action card names one", () => {
  assert.equal(nextStep({ pathname: "/brands/brand-1", brandId: "brand-1" }), null);
});

test("the loop runs Intelligence, Content, Calibration, then back to Content", () => {
  const next = (pathname: string) => nextStep({ pathname, brandId: "brand-1" })?.label;
  assert.equal(next("/brands/brand-1/intelligence"), "Content");
  assert.equal(next("/brands/brand-1/content"), "Calibration");
  assert.equal(next("/brands/brand-1/calibration"), "Content");
  assert.equal(nextStep({ pathname: "/brands/brand-1/studio", brandId: "brand-1" }), null, "an old screen path is not in the sidebar, so it has no next step");
});

test("the setup guide's next step is the workspace overview, and off-sidebar pages have none", () => {
  assert.equal(nextStep({ pathname: "/setup" })?.to, "/");
  assert.equal(nextStep({ pathname: "/brands/new" }), null, "the create page is not in the sidebar");
  assert.equal(nextStep({ pathname: "/invite" }), null);
  assert.equal(nextStep({ pathname: "/brands/brand-1/studio" }), null, "a brand page without a brand id is not a brand screen");
});

test("the command palette lists every sidebar screen and every screen under Settings, once each", () => {
  for (const brandId of [undefined, "brand-1"]) {
    const screens = paletteScreens(brandId);
    const tos = screens.map((screen) => screen.to);
    assert.equal(new Set(tos).size, tos.length, "no screen is listed twice");
    const sidebar = sidebarGroups({ brandId, reviewCount: null }).flatMap((group) => group.items);
    for (const item of sidebar) assert.ok(tos.includes(item.to), `${item.label} is in the palette`);
    for (const link of SETTINGS_SCREEN_LINKS) assert.ok(tos.includes(link.to), `${link.label} is in the palette`);
  }
  assert.ok(paletteScreens("brand-1").some((screen) => screen.to === "/notifications"), "a moved screen is still found by the palette");
});

test("the content page shows the open review count only for a real count above zero", () => {
  const badgeOf = (reviewCount: number | null) => sidebarGroups({ brandId: "b", reviewCount })
    .flatMap((group) => group.items).find((item) => item.id === "content")?.badge;
  assert.equal(badgeOf(null), undefined, "a count that has not loaded shows no badge");
  assert.equal(badgeOf(0), undefined, "zero shows no badge");
  assert.equal(badgeOf(3), 3);
});

test("the review count is absent on workspace pages", () => {
  const items = sidebarGroups({ reviewCount: 5 }).flatMap((group) => group.items);
  assert.equal(items.some((item) => item.badge !== undefined), false);
});

test("bottom tabs are the workspace four off brand pages and the brand four on them", () => {
  assert.deepEqual(bottomTabs().map((tab) => tab.to), ["/", "/setup", "/alerts", "/settings"]);
  assert.deepEqual(bottomTabs("brand-1").map((tab) => tab.to), ["/brands/brand-1", "/brands/brand-1/content", "/brands/brand-1/market", "/brands/brand-1/calibration"]);
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

function itemIds(groups: ReturnType<typeof sidebarGroups>, groupId: string): string[] {
  return groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? [];
}

test("the brand sidebar opens the Content page from one item, and keeps Calibration under Results", () => {
  const groups = sidebarGroups({ brandId: "b1", reviewCount: null });
  assert.deepEqual(itemIds(groups, "content"), ["content"], "ideas, create, review, library, publish, results and ads are sections of that page");
  const content = groups.flatMap((group) => group.items).find((item) => item.id === "content");
  assert.equal(content?.to, "/brands/b1/content", "the sidebar item opens the brand's content page");
  assert.deepEqual(itemIds(groups, "results"), ["calibration"]);
  const calibration = groups.flatMap((group) => group.items).find((item) => item.id === "calibration");
  assert.equal(calibration?.to, "/brands/b1/calibration");
});

test("connected accounts are a section of the content page, and notification preferences are listed under Settings", () => {
  const groups = sidebarGroups({ brandId: "b1", reviewCount: null });
  assert.equal(groups.flatMap((group) => group.items).some((item) => item.to === "/brands/b1/accounts"), false, "accounts open from the Publish section");
  assert.equal(itemIds(groups, "settings").includes("notifications"), false, "notification preferences moved out of the sidebar");
  assert.ok(SETTINGS_SCREEN_LINKS.some((link) => link.to === "/notifications"), "notification preferences stay reachable from Settings");
});

test("workspace pages show the workspace overview and the Settings group, with no brand groups", () => {
  const groups = sidebarGroups({ reviewCount: null });
  assert.deepEqual(groups.map((group) => group.id), ["overview", "settings"]);
  assert.ok(itemIds(groups, "settings").includes("integrations"));
});

test("the collapsed rail keeps a switcher, and the expanded sidebar and mobile sheet keep the selects", () => {
  assert.equal(switcherMode({ collapsed: true, mobile: false }), "rail-button", "the rail is too narrow for a select, so it keeps a button");
  assert.equal(switcherMode({ collapsed: false, mobile: false }), "selects");
  assert.equal(switcherMode({ collapsed: true, mobile: true }), "selects", "the mobile sheet is never collapsed");
  assert.equal(switcherMode({ collapsed: false, mobile: true }), "selects");
});
