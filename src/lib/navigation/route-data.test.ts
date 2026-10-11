import assert from "node:assert/strict";
import test from "node:test";
import { routePageTitle } from "./route-data.ts";

test("the deepest matched route with a page title names the page", () => {
  assert.equal(routePageTitle([{ staticData: { pageTitle: "Workspace" } }, {}, { staticData: { pageTitle: "Studio" } }]), "Studio");
  assert.equal(routePageTitle([{ staticData: { pageTitle: "Workspace" } }, {}]), "Workspace");
  assert.equal(routePageTitle([{ staticData: { pageTitle: "" } }, { staticData: { pageTitle: "Jobs" } }, {}]), "Jobs", "an empty title is skipped");
  assert.equal(routePageTitle([{}, {}]), undefined);
  assert.equal(routePageTitle([]), undefined);
});
