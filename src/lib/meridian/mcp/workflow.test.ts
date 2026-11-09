// The connector's video workflow: phases go in order; in Studio mode every checkpoint but render is the person's (options shown first,
// then their choice or their own words); Guided leaves the person the script and the final cut; Orchestrator leaves them none; a reopen
// clears the phase and every later one; nothing is paid for before the asset plan is settled or past the video's own budget; the intake
// skips the brand question when there is one brand and offers only the styles a chat can make; the next step carries the word budget and
// the style's rules; and the prompts start the intake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMessage } from "./protocol.ts";
import { CONNECTOR_PROMPTS } from "./registry.ts";
import {
  applyCheckpoint,
  checkpointProblem,
  currentPhase,
  decidesFor,
  intakeQuestions,
  nextStep,
  paidCallProblem,
  PHASES,
  styleOptions,
  type Brief,
  type CheckpointRequest,
  type Checkpoints,
  type ProjectMode,
  type ProjectState,
} from "./workflow.ts";

const NOW = "2026-11-09T10:00:00.000Z";
const brief: Brief = {
  goal: "Sell a product",
  idea: "Our double-wall mug keeps coffee hot for two hours",
  platform: "Reels / TikTok / Shorts",
  seconds: 30,
  style: { id: "ck_voice_listicle", label: "Voice-led list", instructions: [{ role: "script", text: "One item to a beat." }] },
  voice: { wanted: true, tone: "warm and calm" },
  language: "en",
  render: "chat",
  audience: "office workers",
};
const project = (mode: ProjectMode, checkpoints: Checkpoints = {}, extra: Partial<ProjectState> = {}): ProjectState => ({ id: "p1", title: "Mug", brandId: "b1", mode, status: "active", brief, checkpoints, budgetUsd: null, spentUsd: 0, ...extra });

/** Applies requests in order, failing on the first refusal. */
function run(mode: ProjectMode, requests: CheckpointRequest[]): Checkpoints {
  let checkpoints: Checkpoints = {};
  for (const request of requests) {
    const problem = checkpointProblem(project(mode, checkpoints), request);
    assert.equal(problem, null, `${request.action} ${request.phase}: ${problem}`);
    checkpoints = applyCheckpoint(checkpoints, request, NOW);
  }
  return checkpoints;
}

const options = [{ label: "A", summary: "Cold coffee at hour two" }, { label: "B", summary: "Still hot at hour two" }];

describe("video workflow", () => {
  it("decides who settles each phase by mode", () => {
    assert.deepEqual(PHASES.filter((phase) => decidesFor("studio", phase) === "person"), ["concept", "script", "storyboard", "assets", "build", "deliver"]);
    assert.deepEqual(PHASES.filter((phase) => decidesFor("guided", phase) === "person"), ["script", "deliver"]);
    assert.deepEqual(PHASES.filter((phase) => decidesFor("orchestrator", phase) === "person"), []);
  });

  it("in Studio, a checkpoint needs options shown, then the person's own choice or words", () => {
    const fresh = project("studio");
    assert.match(checkpointProblem(fresh, { action: "resolve", phase: "concept", decidedBy: "chat", content: "x" }) ?? "", /person's choice in Studio mode/);
    assert.match(checkpointProblem(fresh, { action: "resolve", phase: "concept", decidedBy: "person", choice: "A", content: "x" }) ?? "", /Propose the options/);
    assert.match(checkpointProblem(fresh, { action: "propose", phase: "concept", options: [options[0]!] }) ?? "", /at least two options/);
    const proposed = run("studio", [{ action: "propose", phase: "concept", options }]);
    assert.equal(proposed.concept?.status, "proposed");
    assert.match(checkpointProblem(project("studio", proposed), { action: "resolve", phase: "concept", decidedBy: "person", choice: "C", content: "x" }) ?? "", /not one of the options/);
    assert.match(checkpointProblem(project("studio", proposed), { action: "resolve", phase: "concept", decidedBy: "person", choice: "B" }) ?? "", /Send the settled concept/);
    const settled = run("studio", [{ action: "propose", phase: "concept", options }, { action: "resolve", phase: "concept", decidedBy: "person", choice: "B", input: "but warmer", content: "Still hot at hour two" }]);
    assert.equal(settled.concept?.decidedBy, "person");
    assert.equal(settled.concept?.input, "but warmer");
    assert.equal(currentPhase(settled), "script");
  });

  it("keeps the order: no phase before the one before it, and a settled phase only changes by reopening", () => {
    assert.match(checkpointProblem(project("orchestrator"), { action: "resolve", phase: "script", decidedBy: "chat", content: "x" }) ?? "", /Settle Concept first/);
    const two = run("orchestrator", [{ action: "resolve", phase: "concept", decidedBy: "decision_engine", content: "c" }, { action: "resolve", phase: "script", decidedBy: "chat", content: "s" }]);
    assert.match(checkpointProblem(project("orchestrator", two), { action: "resolve", phase: "concept", decidedBy: "chat", content: "c2" }) ?? "", /already settled.*reopen/);
    const reopened = applyCheckpoint(two, { action: "reopen", phase: "concept" }, NOW);
    assert.deepEqual(Object.keys(reopened), [], "a reopen clears the phase and every later one");
    assert.match(checkpointProblem(project("orchestrator"), { action: "reopen", phase: "script" }) ?? "", /not settled/);
  });

  it("in Guided mode the chat settles the concept, the person the script", () => {
    const concept = run("guided", [{ action: "resolve", phase: "concept", decidedBy: "chat", content: "Still hot at hour two" }]);
    assert.match(checkpointProblem(project("guided", concept), { action: "resolve", phase: "script", decidedBy: "chat", content: "s" }) ?? "", /person's choice in Guided mode/);
  });

  it("runs a whole Orchestrator video to the end, then refuses more checkpoints", () => {
    const requests: CheckpointRequest[] = PHASES.map((phase) => ({ action: "resolve", phase, decidedBy: "chat", content: `${phase} settled` }));
    const done = run("orchestrator", requests);
    assert.equal(currentPhase(done), null);
    assert.match(checkpointProblem(project("orchestrator", done), { action: "resolve", phase: "deliver", decidedBy: "chat" }) ?? "", /Every phase is settled|already settled/);
    assert.match(checkpointProblem(project("orchestrator", done, { status: "delivered" }), { action: "resolve", phase: "deliver", decidedBy: "chat" }) ?? "", /delivered/);
  });

  it("pays for media only after the asset plan, and never past the video's own budget", () => {
    const beforeAssets = project("orchestrator", run("orchestrator", ["concept", "script", "storyboard"].map((phase) => ({ action: "resolve" as const, phase: phase as "concept", decidedBy: "chat" as const, content: "x" }))));
    assert.match(paidCallProblem(beforeAssets, "image", 1) ?? "", /Settle the asset plan first/);
    assert.equal(paidCallProblem(beforeAssets, "decision", 0), null, "a decision may help at any phase");
    const withAssets = project("orchestrator", applyCheckpoint(beforeAssets.checkpoints, { action: "resolve", phase: "assets", decidedBy: "chat", content: "one voiceover, two images" }, NOW), { budgetUsd: 3, spentUsd: 2.5 });
    assert.match(paidCallProblem(withAssets, "image", 1) ?? "", /\$0\.50 is left, less than this call's hold of \$1\.00/);
    assert.equal(paidCallProblem({ ...withAssets, budgetUsd: 4 }, "image", 1), null);
    assert.equal(paidCallProblem({ ...withAssets, budgetUsd: null }, "voiceover", 1), null, "no cap beyond the brand budget");
  });

  it("asks the brand only when there is more than one, and offers the styles a chat can make plus kinetic type", () => {
    const styles = styleOptions([
      { cookbookId: "ck_voice_listicle", label: "Voice-led list", summary: "Spoken list.", modes: ["agent", "engine"] },
      { cookbookId: "ck_engine", label: "Engine only", summary: "No.", modes: ["engine"] },
    ]);
    assert.deepEqual(styles.map((style) => style.label), ["Voice-led list", "Kinetic type"]);
    const one = intakeQuestions({ brands: [{ id: "b1", name: "Calm Mug", leftUsd: 5 }], styles });
    assert.ok(!one.some((question) => question.id === "brand"));
    assert.deepEqual(one.map((question) => question.id), ["goal", "idea", "format", "style", "voice", "mode", "render", "budget"]);
    const two = intakeQuestions({ brands: [{ id: "b1", name: "Calm Mug", leftUsd: 5 }, { id: "b2", name: "Bare", leftUsd: null }], styles });
    assert.deepEqual(two[0]!.options, ["Calm Mug ($5.00 left)", "Bare (no budget set: paid steps are refused)"]);
  });

  it("tells the chat the next move: the word budget, the style's rules, and the person's checkpoint", () => {
    const first = nextStep(project("studio"));
    assert.match(first, /^Next: Concept/);
    assert.match(first, /One item to a beat/);
    assert.match(first, /action: "propose"/);
    assert.match(first, /WAIT|wait for their answer/);
    const script = nextStep(project("studio", run("studio", [{ action: "propose", phase: "concept", options }, { action: "resolve", phase: "concept", decidedBy: "person", choice: "B", content: "Still hot at hour two" }])));
    assert.match(script, /At most 75 spoken words for 30 s/);
    assert.match(script, /Still hot at hour two/);
    const orchestrated = nextStep(project("orchestrator"));
    assert.match(orchestrated, /You settle this checkpoint/);
    assert.match(orchestrated, /meridian_decide/);
    const waiting = nextStep(project("studio", run("studio", [{ action: "propose", phase: "concept", options }])));
    assert.match(waiting, /Wait for the person's answer/);
  });

  it("offers prompts that start the intake, and refuses an unknown prompt", async () => {
    const protocol = { role: "member" as const, tools: [], context: {}, prompts: CONNECTOR_PROMPTS };
    const listed = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "prompts/list" }, protocol)) as { result: { prompts: Array<{ name: string }> } };
    assert.deepEqual(listed.result.prompts.map((prompt) => prompt.name), ["make_video", "studio_video", "resume_video"]);
    const got = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "make_video", arguments: { idea: "our mug" } } }, protocol)) as { result: { messages: Array<{ content: { text: string } }> } };
    assert.match(got.result.messages[0]!.content.text, /about: our mug\. Start with meridian_start/);
    const init = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }, protocol)) as { result: { capabilities: Record<string, unknown>; instructions: string } };
    assert.deepEqual(init.result.capabilities.prompts, { listChanged: false });
    assert.match(init.result.instructions, /call meridian_start FIRST/);
    const unknown = (await handleMessage({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "nope" } }, protocol)) as { error: { code: number } };
    assert.equal(unknown.error.code, -32602);
  });
});
