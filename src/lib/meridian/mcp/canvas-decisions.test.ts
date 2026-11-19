import assert from "node:assert/strict";
import test from "node:test";
import { clearedByReopen, isPhase, isProjectMode, personResolution, reopenProblem } from "./canvas-decisions.ts";
import { checkpointProblem, type Checkpoints, type ProjectState } from "./workflow.ts";

const settled = (content: string) => ({ status: "resolved" as const, options: [], proposedAt: null, choice: null, input: null, decidedBy: "chat" as const, content, resolvedAt: "2026-11-18T10:00:00.000Z" });
const proposed = { status: "proposed" as const, options: [{ label: "Bold", summary: "A loud hook." }, { label: "Calm", summary: "A slow reveal." }], proposedAt: "2026-11-18T10:00:00.000Z", choice: null, input: null, decidedBy: null, content: null, resolvedAt: null };

function project(mode: ProjectState["mode"], checkpoints: Checkpoints, status: ProjectState["status"] = "active"): Pick<ProjectState, "mode" | "status" | "checkpoints"> {
  return { mode, status, checkpoints };
}

test("a person settles their own proposed step with an option, and the option's summary is what the next step builds on", () => {
  const result = personResolution(project("studio", { concept: proposed }), "concept", { choice: "Calm" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request, { action: "resolve", phase: "concept", decidedBy: "person", choice: "Calm", input: null, content: "Calm: A slow reveal." });
  // The stored rules accept it too.
  assert.equal(checkpointProblem(project("studio", { concept: proposed }), result.request), null);
});

test("the person's own words win over a picked option and become the settled text", () => {
  const result = personResolution(project("studio", { concept: proposed }), "concept", { choice: "Bold", input: "  A cat explains tides.  " });
  assert.equal(result.ok && result.request.action === "resolve" ? result.request.content : null, "A cat explains tides.");
});

test("the canvas never settles a step the chat decides, nor one with no options yet, nor one that is not active", () => {
  const chatStep = personResolution(project("orchestrator", { concept: proposed }), "concept", { choice: "Bold" });
  assert.deepEqual(chatStep, { ok: false, reason: "Concept is settled by the chat in Orchestrator mode. Switch to Studio to choose it yourself." });
  const guidedConcept = personResolution(project("guided", { concept: proposed }), "concept", { choice: "Bold" });
  assert.equal(guidedConcept.ok, false);
  assert.equal(personResolution(project("studio", {}), "concept", { choice: "Bold" }).ok, false);
  assert.equal(personResolution(project("studio", { concept: proposed }, "abandoned"), "concept", { choice: "Bold" }).ok, false);
  assert.equal(personResolution(project("studio", { concept: proposed }), "render", { input: "now" }).ok, false, "render is never the person's");
});

test("an answer must be an offered option or the person's own words", () => {
  assert.deepEqual(personResolution(project("studio", { concept: proposed }), "concept", {}), { ok: false, reason: "Pick one of the options, or write your own." });
  assert.deepEqual(personResolution(project("studio", { concept: proposed }), "concept", { choice: "Loud" }), { ok: false, reason: "'Loud' is not one of the options offered for Concept." });
  assert.equal(personResolution(project("studio", { concept: proposed }), "concept", { input: "x".repeat(20_001) }).ok, false);
});

test("a reopen needs a settled step on an active video and clears it with every later step that holds anything", () => {
  const checkpoints: Checkpoints = { concept: settled("c"), script: settled("s"), storyboard: proposed };
  assert.equal(reopenProblem(project("studio", checkpoints), "script"), null);
  assert.equal(reopenProblem(project("studio", checkpoints), "storyboard"), "Storyboard is not settled, so there is nothing to reopen.");
  assert.equal(reopenProblem(project("studio", checkpoints, "delivered"), "script"), "This video is delivered.");
  assert.deepEqual(clearedByReopen({ checkpoints }, "script"), ["script", "storyboard"]);
});

test("phase and mode guards accept only the workflow's own names", () => {
  assert.equal(isPhase("storyboard"), true);
  assert.equal(isPhase("edit"), false);
  assert.equal(isProjectMode("guided"), true);
  assert.equal(isProjectMode("auto"), false);
});
