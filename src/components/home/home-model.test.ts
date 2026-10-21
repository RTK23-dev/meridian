import assert from "node:assert/strict";
import test from "node:test";
import { attentionItems, isThinBrand, needsYouItems } from "./home-model.ts";

test("a brand is thin until every required brain field has content, whatever its ratio says", () => {
  assert.equal(isThinBrand({ requiredComplete: false }), true);
  assert.equal(isThinBrand({ requiredComplete: true }), false);
});

test("a thin brand is listed with the share of required fields filled, and a complete brand is not listed", () => {
  const items = attentionItems({
    reviewsByBrand: [],
    failedJobs: 0,
    connections: [],
    thinBrands: [{ brandId: "brand-a", brandName: "Soap Co", ratio: 0.5 }],
  });
  const thin = items.find((item) => item.id === "brain:brand-a");
  assert.equal(thin?.title, "Soap Co’s brand brain is thin");
  assert.equal(thin?.detail, "50% of required brain fields are filled");
  assert.equal(thin?.to, "/brands/$brandId/brain");
  const none = attentionItems({ reviewsByBrand: [], failedJobs: 0, connections: [], thinBrands: [] });
  assert.equal(none.some((item) => item.id.startsWith("brain:")), false);
});

test("a plan is listed on Home only when it is refused, paused at budget or incomplete", () => {
  const items = needsYouItems({
    plans: [
      { id: "plan_1", title: "Spring launch", status: "refused" },
      { id: "plan_2", title: "  ", status: "paused" },
      { id: "plan_3", title: "Summer", status: "incomplete" },
      { id: "plan_4", title: "Draft", status: "draft" },
      { id: "plan_5", title: "Running", status: "running" },
      { id: "plan_6", title: "Done", status: "complete" },
    ],
    accounts: [],
  });
  assert.deepEqual(items.map((item) => item.id), ["plan:plan_1", "plan:plan_2", "plan:plan_3"]);
  assert.equal(items.find((item) => item.id === "plan:plan_1")?.title, "Spring launch was refused");
  assert.equal(items.find((item) => item.id === "plan:plan_2")?.title, "Untitled plan paused at budget");
  assert.equal(items.find((item) => item.id === "plan:plan_3")?.title, "Summer is incomplete");
  assert.deepEqual(items.find((item) => item.id === "plan:plan_3")?.action, { label: "Open plan", to: "/create/plan_3/plan" });
});

test("an account is listed only when its stored state is not connected, and the item says how to connect it", () => {
  const items = needsYouItems({
    plans: [],
    accounts: [
      { id: "acc_1", brandId: "brand-a", name: "Instagram", state: "not_connected" },
      { id: "acc_2", brandId: "brand-a", name: "YouTube", state: "connected" },
      { id: "acc_3", brandId: "brand-b", name: "Facebook", state: "unknown" },
    ],
  });
  assert.deepEqual(items, [{
    id: "account:acc_1",
    title: "Instagram is not connected",
    reason: "Connect it to publish from this brand.",
    action: { label: "Connect account", to: "/brands/brand-a/accounts" },
  }]);
});

test("nothing needs you when no plan or account is in a state that needs action", () => {
  assert.deepEqual(needsYouItems({ plans: [], accounts: [] }), []);
});
