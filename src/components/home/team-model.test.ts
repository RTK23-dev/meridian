import assert from "node:assert/strict";
import test from "node:test";
import { ownsJobType, teamStates, type JobCount } from "./team-model.ts";

const toneOf = (states: ReturnType<typeof teamStates>, id: string) => states.find((state) => state.id === id)?.tone;
const labelOf = (states: ReturnType<typeof teamStates>, id: string) => states.find((state) => state.id === id)?.label;

test("a job type belongs to an agent by its prefix and a dot, never by a longer word", () => {
  assert.equal(ownsJobType(["research"], "research.collect"), true);
  assert.equal(ownsJobType(["research"], "research"), true);
  assert.equal(ownsJobType(["research"], "researchers.sync"), false);
  assert.equal(ownsJobType(["factory"], "factory.produce"), true);
  assert.equal(ownsJobType(["publishing"], "alert.deliver"), false);
});

test("the counts have not loaded, so every agent is checking, not idle", () => {
  const states = teamStates({ jobs: null, openReviews: null });
  assert.equal(states.length, 4);
  assert.ok(states.every((state) => state.tone === "checking"));
});

test("a running job makes its agent working, and a queued job makes it queued", () => {
  const jobs: JobCount[] = [
    { type: "factory.produce", status: "running", count: 2 },
    { type: "publishing.dispatch", status: "queued", count: 1 },
  ];
  const states = teamStates({ jobs, openReviews: 0 });
  assert.equal(toneOf(states, "art_director"), "working");
  assert.equal(labelOf(states, "art_director"), "Working on 2 jobs");
  assert.equal(toneOf(states, "publisher"), "queued");
  assert.equal(toneOf(states, "analyst"), "idle");
});

test("a failed job in the last day blocks its agent, and that beats running work", () => {
  const jobs: JobCount[] = [
    { type: "research.collect", status: "dead", count: 1 },
    { type: "research.collect", status: "running", count: 3 },
  ];
  const states = teamStates({ jobs, openReviews: null });
  assert.equal(toneOf(states, "analyst"), "blocked");
  assert.equal(labelOf(states, "analyst"), "1 job failed in the last day");
});

test("reviews waiting on the person make the art director wait, and only the art director waits on reviews", () => {
  const states = teamStates({ jobs: [], openReviews: 3 });
  assert.equal(toneOf(states, "art_director"), "waiting");
  assert.equal(labelOf(states, "art_director"), "3 reviews need you");
  assert.equal(toneOf(states, "publisher"), "idle");
  assert.equal(teamStates({ jobs: [], openReviews: 1 }).find((state) => state.id === "art_director")?.label, "1 review needs you");
});

test("reviews that have not loaded never make the art director wait", () => {
  const states = teamStates({ jobs: [], openReviews: null });
  assert.equal(toneOf(states, "art_director"), "idle");
});

test("a job type that no agent owns is not shown on any agent", () => {
  const states = teamStates({ jobs: [{ type: "alert.deliver", status: "dead", count: 5 }], openReviews: 0 });
  assert.ok(states.every((state) => state.tone === "idle"));
});
