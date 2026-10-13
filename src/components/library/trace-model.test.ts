import assert from "node:assert/strict";
import test from "node:test";
import { buildTraceTimeline, type TraceInput } from "./trace-model.ts";

function traceInput(overrides: Partial<TraceInput>): TraceInput {
  return {
    creativeId: "creative-1",
    creativeStatus: "in_review",
    opportunity: null,
    decisions: [],
    brief: null,
    observations: [],
    mediaLoad: "ready",
    media: [],
    reviewsLoad: "ready",
    reviews: [],
    reviewsTruncated: false,
    ...overrides,
  };
}

test("a performance row shows a metric the source did not report as not reported, never as zero", () => {
  const stages = buildTraceTimeline(traceInput({
    observations: [{
      observedOn: "2026-10-06",
      impressions: null,
      clicks: 12,
      conversions: null,
      ctr: null,
      cpmCents: null,
      source: "meta",
    }],
  }));
  const performance = stages.find((stage) => stage.id === "performance");
  assert.ok(performance);
  assert.equal(performance.recorded, true);
  const detail = performance.entries[0]?.detail ?? "";
  assert.match(detail, /Impressions not reported, clicks 12, conversions not reported\./);
  assert.doesNotMatch(detail, /null/);
  assert.doesNotMatch(detail, /Impressions 0\b/);
  assert.match(detail, /CTR not computable\./);
});

test("a reported count is shown as reported, including a measured zero", () => {
  const stages = buildTraceTimeline(traceInput({
    observations: [{
      observedOn: "2026-10-06",
      impressions: 400,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpmCents: 250,
      source: "meta",
    }],
  }));
  const detail = stages.find((stage) => stage.id === "performance")?.entries[0]?.detail ?? "";
  assert.match(detail, /Impressions 400, clicks 0, conversions 0\./);
  assert.match(detail, /CTR 0\.0%\./);
  assert.match(detail, /CPM 250 cents\./);
});

test("a decision with no probability shows the probability as unknown", () => {
  const stages = buildTraceTimeline(traceInput({
    decisions: [{
      id: "decision-1",
      question: "brand_fit.v1",
      decision: "HUMAN_REVIEW",
      probability: null,
      reasons: ["No evidence was supplied."],
      createdAt: "2026-10-06T10:00:00.000Z",
    }],
  }));
  const title = stages.find((stage) => stage.id === "decision")?.entries[0]?.title ?? "";
  assert.match(title, /probability unknown/);
  assert.doesNotMatch(title, /probability 0%/);
});
