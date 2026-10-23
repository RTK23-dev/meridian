import assert from "node:assert/strict";
import test from "node:test";
import { evidenceSourceLabel, RANKING_INPUTS_NOTE } from "./opportunity-model.ts";

test("each evidence source reads as the kind of stored evidence it is", () => {
  assert.equal(evidenceSourceLabel("creative_records"), "Stored creatives");
  assert.equal(evidenceSourceLabel("market"), "Stored creatives");
  assert.equal(evidenceSourceLabel("jev_research"), "JEV Research (Meta Ad Library)");
  assert.equal(evidenceSourceLabel("learned_pattern"), "Your recorded results");
  assert.equal(evidenceSourceLabel("reviews"), "Your review decisions");
  assert.equal(evidenceSourceLabel("brand_brain"), "Brand brain");
  assert.equal(evidenceSourceLabel("workflow"), "Workflow template");
  assert.equal(evidenceSourceLabel("vision"), "Creative visual analysis");
});

test("every evidence source the JEV gate records has a label, so none falls back to unknown", () => {
  for (const source of ["brand_brain", "brand_rules", "brief", "claim_rules", "learned_pattern", "market", "performance", "product_record", "reviews", "vision", "workflow"]) {
    assert.notEqual(evidenceSourceLabel(source), "Other stored evidence", `${source} has a label`);
  }
});

test("a source that is not known is named as other stored evidence, never guessed", () => {
  assert.equal(evidenceSourceLabel("youtube"), "Other stored evidence");
  assert.equal(evidenceSourceLabel(""), "Other stored evidence");
});

test("the ranking note says that discovered pages are stored but not ranked", () => {
  assert.match(RANKING_INPUTS_NOTE, /Pages and posts found on Market are stored as evidence, and ranking does not read them yet/);
});
