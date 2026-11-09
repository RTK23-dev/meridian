// The connector's video workflow, pure so every rule is tested without a database. A chat (Claude or ChatGPT) that receives the connector
// first runs a short intake Q&A, then makes the video as a project through seven phases, in order:
//
//   concept → script → storyboard → assets → build → render → deliver
//
// Each phase ends at a checkpoint. How involved the person chose to be decides who settles each checkpoint:
//   studio:       the person, at every checkpoint but render: the chat proposes options, the person picks one or writes their own;
//   guided:       the person settles the script and the final cut; the chat (or the decision engine) settles the rest;
//   orchestrator: hands-off; the chat settles every checkpoint, asking the decision engine where a choice matters.
// Meridian keeps the order and who decided: a phase cannot be settled before the one before it, a person's checkpoint needs options
// shown first and the person's own choice, and nothing is generated (paid) before the asset plan is settled. Going back is a reopen,
// which clears the phase and every phase after it.

export const PROJECT_MODES = ["studio", "guided", "orchestrator"] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];

export const MODE_COPY: Record<ProjectMode, { label: string; summary: string }> = {
  studio: { label: "Studio", summary: "You choose at every step: concept, script, storyboard, assets, the preview and the final cut. The chat offers options; you pick one or say your own." },
  guided: { label: "Guided", summary: "You approve the script and the final cut; the chat handles the rest." },
  orchestrator: { label: "Orchestrator", summary: "Hands-off: the chat makes every choice, asking Meridian's decision engine where it matters, and shows you the result." },
};

export const PHASES = ["concept", "script", "storyboard", "assets", "build", "render", "deliver"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_COPY: Record<Phase, { label: string; settles: string }> = {
  concept: { label: "Concept", settles: "the idea: the hook, the angle and why it serves the goal" },
  script: { label: "Script", settles: "the words, beat by beat, with timings that fit the length" },
  storyboard: { label: "Storyboard", settles: "every scene: what is seen, the on-screen text, the line spoken and its seconds" },
  assets: { label: "Asset plan", settles: "the voiceover takes and images to make, and what they will hold on the budget" },
  build: { label: "Build", settles: "the coded video (the HyperFrames composition), previewed" },
  render: { label: "Render", settles: "the MP4, or the code and files when no render was asked for" },
  deliver: { label: "Deliver", settles: "the final cut, approved, with where it is" },
};

/** The phases whose checkpoint is the person's own, in each mode. */
export const PERSON_DECIDES: Record<ProjectMode, ReadonlySet<Phase>> = {
  studio: new Set<Phase>(["concept", "script", "storyboard", "assets", "build", "deliver"]),
  guided: new Set<Phase>(["script", "deliver"]),
  orchestrator: new Set<Phase>(),
};

/** The phases whose settled text is kept: the chat must send what was settled, so the next phase builds on it. */
const CONTENT_REQUIRED = new Set<Phase>(["concept", "script", "storyboard", "assets"]);

export const DECIDERS = ["person", "chat", "decision_engine"] as const;
export type Decider = (typeof DECIDERS)[number];

export type CheckpointOption = { label: string; summary: string };

export type Checkpoint = {
  status: "proposed" | "resolved";
  options: CheckpointOption[];
  proposedAt: string | null;
  choice: string | null;
  input: string | null;
  decidedBy: Decider | null;
  content: string | null;
  resolvedAt: string | null;
};

export type Checkpoints = Partial<Record<Phase, Checkpoint>>;

export type RenderChoice = "chat" | "code_only";

export type Brief = {
  goal: string;
  idea: string;
  platform: string;
  seconds: number;
  style: { id: string | null; label: string; instructions: Array<{ role: string; text: string }> };
  voice: { wanted: boolean; tone: string };
  language: string;
  render: RenderChoice;
  audience: string;
};

export type ProjectStatus = "active" | "delivered" | "abandoned";

export type ProjectState = {
  id: string;
  title: string;
  /** Null: a video made without a brand. It is the workspace's own, paid from the monthly budget. */
  brandId: string | null;
  mode: ProjectMode;
  status: ProjectStatus;
  brief: Brief;
  checkpoints: Checkpoints;
  budgetUsd: number | null;
  spentUsd: number;
};

export const CONTENT_MAX = 20_000;
/** A natural speaking pace for a short video's voiceover, in words per second; the script's word budget follows from it. */
export const WORDS_PER_SECOND = 2.5;

/** The first phase not yet settled, or null when every phase is. */
export function currentPhase(checkpoints: Checkpoints): Phase | null {
  return PHASES.find((phase) => checkpoints[phase]?.status !== "resolved") ?? null;
}

export function decidesFor(mode: ProjectMode, phase: Phase): "person" | "chat" {
  return PERSON_DECIDES[mode].has(phase) ? "person" : "chat";
}

export type CheckpointRequest =
  | { action: "propose"; phase: Phase; options: CheckpointOption[] }
  | { action: "resolve"; phase: Phase; decidedBy: Decider; choice?: string | null; input?: string | null; content?: string | null }
  | { action: "reopen"; phase: Phase };

const index = (phase: Phase) => PHASES.indexOf(phase);

/** Why a checkpoint request cannot be applied, in words the chat can act on; null when it can. */
export function checkpointProblem(project: Pick<ProjectState, "mode" | "status" | "checkpoints">, request: CheckpointRequest): string | null {
  if (project.status !== "active") return `This video is ${project.status}; start a new one with meridian_project_create.`;
  const current = currentPhase(project.checkpoints);
  const label = PHASE_COPY[request.phase].label;
  if (request.action === "reopen") {
    if (project.checkpoints[request.phase]?.status !== "resolved") return `${label} is not settled, so there is nothing to reopen.`;
    return null;
  }
  if (current === null) return "Every phase is settled. Reopen a phase to change it.";
  if (index(request.phase) < index(current)) return `${label} is already settled. To change it, reopen it (this clears every later phase).`;
  if (index(request.phase) > index(current)) return `Settle ${PHASE_COPY[current].label} first: phases go in order.`;
  const personal = decidesFor(project.mode, request.phase) === "person";
  if (request.action === "propose") {
    if (personal && request.options.length < 2) return `${label} is the person's choice in ${MODE_COPY[project.mode].label} mode: offer at least two options.`;
    return null;
  }
  const existing = project.checkpoints[request.phase];
  const choice = request.choice?.trim() || null;
  const input = request.input?.trim() || null;
  if (personal) {
    if (request.decidedBy !== "person") return `${label} is the person's choice in ${MODE_COPY[project.mode].label} mode. Show the options, wait for their answer, then resolve with decidedBy "person".`;
    if (existing?.status !== "proposed" || existing.options.length < 2) return `Propose the options for ${label} first (action "propose"), and show them to the person.`;
    if (!choice && !input) return "Say what the person chose (choice: an option's label) or what they wrote (input).";
    if (choice && !existing.options.some((option) => option.label === choice)) return `'${choice}' is not one of the options proposed for ${label}: ${existing.options.map((option) => option.label).join(", ")}.`;
  }
  if (CONTENT_REQUIRED.has(request.phase) && !(request.content ?? "").trim()) return `Send the settled ${label.toLowerCase()} as content, so the next phase builds on it.`;
  return null;
}

/** The checkpoints after a request that checkpointProblem accepted. */
export function applyCheckpoint(checkpoints: Checkpoints, request: CheckpointRequest, now: string): Checkpoints {
  const next: Checkpoints = { ...checkpoints };
  if (request.action === "reopen") {
    for (const phase of PHASES.slice(index(request.phase))) delete next[phase];
    return next;
  }
  if (request.action === "propose") {
    next[request.phase] = { status: "proposed", options: request.options, proposedAt: now, choice: null, input: null, decidedBy: null, content: null, resolvedAt: null };
    return next;
  }
  const existing = checkpoints[request.phase];
  next[request.phase] = {
    status: "resolved",
    options: existing?.options ?? [],
    proposedAt: existing?.proposedAt ?? null,
    choice: request.choice?.trim() || null,
    input: request.input?.trim() || null,
    decidedBy: request.decidedBy,
    content: request.content?.trim().slice(0, CONTENT_MAX) || null,
    resolvedAt: now,
  };
  return next;
}

/** Whether every phase is settled. */
export function isComplete(checkpoints: Checkpoints): boolean {
  return currentPhase(checkpoints) === null;
}

export type PaidKind = "voiceover" | "image" | "decision";

/** Why a paid call for this project cannot be made now; null when it can. The brand's or the monthly budget is checked again when the hold is taken. */
export function paidCallProblem(project: Pick<ProjectState, "status" | "checkpoints" | "budgetUsd" | "spentUsd">, kind: PaidKind, holdUsd: number): string | null {
  if (project.status !== "active") return `This video is ${project.status}; nothing more is made for it.`;
  if (kind !== "decision" && project.checkpoints.assets?.status !== "resolved") {
    return "Settle the asset plan first (phase 'assets'): it says what to make and what it will hold, before anything is paid for.";
  }
  if (project.budgetUsd !== null && project.spentUsd + holdUsd > project.budgetUsd + 1e-9) {
    const left = Math.max(0, project.budgetUsd - project.spentUsd);
    return `This video's own budget is $${project.budgetUsd.toFixed(2)} and $${left.toFixed(2)} is left, less than this call's hold of $${holdUsd.toFixed(2)}. Ask the person whether to raise it (meridian_project_update).`;
  }
  return null;
}

// ---- the intake ---------------------------------------------------------------------------------------------------------------

export type IntakeQuestion = { id: string; question: string; options: string[]; ownAnswer: boolean; required: boolean };

export type StyleOption = { id: string | null; label: string; summary: string };

/** The styles a chat can make itself: Meridian's cookbooks that run in agent mode, then plain kinetic type, then the person's own. */
export function styleOptions(cookbooks: Array<{ cookbookId: string; label: string; summary: string; modes: readonly string[] }>): StyleOption[] {
  return [
    ...cookbooks.filter((cookbook) => cookbook.modes.includes("agent")).map((cookbook) => ({ id: cookbook.cookbookId, label: cookbook.label, summary: cookbook.summary })),
    { id: null, label: "Kinetic type", summary: "Bold animated words and shapes in the brand's colours, no footage." },
  ];
}

/** The words for the workspace's own video (no brand) and what its monthly budget has left. */
export function noBrandOption(workspaceLeftUsd: number | null): string {
  return `No brand: the workspace's own video${workspaceLeftUsd === null ? " (no monthly budget set: paid steps are refused)" : ` (paid from the monthly budget, $${workspaceLeftUsd.toFixed(2)} left)`}`;
}

/**
 * The intake questions. A video does not have to belong to a brand (owner direction 2026-11-09): with brands, the first question offers
 * each of them and "No brand"; with none, it is not asked and the video is the workspace's own.
 */
export function intakeQuestions(input: { brands: Array<{ id: string; name: string; leftUsd: number | null }>; workspaceLeftUsd: number | null; styles: StyleOption[] }): IntakeQuestion[] {
  const questions: IntakeQuestion[] = [];
  if (input.brands.length > 0) {
    questions.push({
      id: "brand",
      question: "Which brand is this video for?",
      options: [
        ...input.brands.map((brand) => `${brand.name}${brand.leftUsd === null ? " (no budget set: paid steps are refused)" : ` ($${brand.leftUsd.toFixed(2)} left)`}`),
        noBrandOption(input.workspaceLeftUsd),
      ],
      ownAnswer: false,
      required: true,
    });
  }
  questions.push(
    { id: "goal", question: "What should the video do?", options: ["Sell a product", "Explain how something works", "Announce something new", "Grow followers with something useful or fun"], ownAnswer: true, required: true },
    { id: "idea", question: "What is it about? A sentence or two, a product, a link or an example you like.", options: [], ownAnswer: true, required: true },
    { id: "format", question: "Where will it run, and how long?", options: ["Reels / TikTok / Shorts, 15 seconds", "Reels / TikTok / Shorts, 30 seconds", "Reels / TikTok / Shorts, 45 to 60 seconds"], ownAnswer: true, required: true },
    { id: "style", question: "Which style?", options: input.styles.map((style) => `${style.label}: ${style.summary}`), ownAnswer: true, required: true },
    { id: "voice", question: "A voiceover?", options: ["Yes, warm and calm", "Yes, upbeat and energetic", "No voice: text and music only"], ownAnswer: true, required: true },
    { id: "mode", question: "How involved do you want to be?", options: PROJECT_MODES.map((mode) => `${MODE_COPY[mode].label}: ${MODE_COPY[mode].summary}`), ownAnswer: false, required: true },
    { id: "render", question: "Who makes the MP4?", options: ["You, in this chat's code sandbox (free, takes a few minutes)", "Nobody yet: give me the code and the files"], ownAnswer: false, required: true },
    { id: "budget", question: "The most Meridian may spend on this video (voice, images, decisions)?", options: ["$1", "$3", "$5", "No cap beyond the brand's or the monthly budget"], ownAnswer: true, required: false },
  );
  return questions;
}

export const INTAKE_INSTRUCTIONS = [
  "Ask these questions in ONE message, numbered, each option lettered (A, B, C...), and say they may answer in their own words.",
  "Keep it short; accept compact answers such as '2B, 3: our new mug, 4A'. Fill nothing in for them: ask again for a required answer they skipped.",
  "Then call meridian_project_create with their answers, and follow the next step it returns.",
].join(" ");

// ---- what the chat does next --------------------------------------------------------------------------------------------------

function wordBudget(seconds: number): number {
  return Math.floor(seconds * WORDS_PER_SECOND);
}

function decideHow(mode: ProjectMode, phase: Phase): string {
  if (decidesFor(mode, phase) === "person") {
    return `This is the person's checkpoint. Call meridian_checkpoint {phase: "${phase}", action: "propose", options}, show the options to the person as A, B, C with one line each and "or tell me your own", wait for their answer, then call meridian_checkpoint {phase: "${phase}", action: "resolve", decidedBy: "person", choice: the option's label or input: their own words${CONTENT_REQUIRED.has(phase) ? ", content: the settled text" : ""}}.`;
  }
  return `You settle this checkpoint. Where a choice matters, ask meridian_decide (kind "choose") and resolve with decidedBy "decision_engine"; otherwise choose yourself and resolve with decidedBy "chat". Call meridian_checkpoint {phase: "${phase}", action: "resolve"${CONTENT_REQUIRED.has(phase) ? ", content: the settled text" : ""}}, then tell the person in one line what you chose and why.`;
}

function settled(project: ProjectState, phase: Phase): string {
  const checkpoint = project.checkpoints[phase];
  return checkpoint?.content ?? checkpoint?.input ?? checkpoint?.choice ?? "(not recorded)";
}

/** The instruction for the chat's next move, from the project's state. */
export function nextStep(project: ProjectState): string {
  const brief = project.brief;
  if (project.status !== "active") return `This video is ${project.status}. Start a new one with meridian_start.`;
  const phase = currentPhase(project.checkpoints);
  if (phase === null) return "Every phase is settled. Mark the video delivered by resolving 'deliver', or reopen a phase to change it.";
  const proposed = project.checkpoints[phase]?.status === "proposed";
  const style = brief.style.instructions.length > 0 ? ` Style rules (${brief.style.label}): ${brief.style.instructions.map((rule) => `${rule.role}: ${rule.text}`).join(" ")}` : ` Style: ${brief.style.label}.`;
  const header = `Next: ${PHASE_COPY[phase].label} (${PHASE_COPY[phase].settles}).`;
  if (proposed) {
    const options = project.checkpoints[phase]!.options.map((option) => option.label).join(", ");
    return `${header} Options were proposed (${options}). Wait for the person's answer, then resolve with decidedBy "person" and their choice or their own words.`;
  }
  const how = decideHow(project.mode, phase);
  switch (phase) {
    case "concept":
      return `${header} Write three distinct concepts for "${brief.idea}" (goal: ${brief.goal}; ${brief.platform}, ${brief.seconds} s${brief.audience ? `; audience: ${brief.audience}` : ""}). Each: a hook that stops the scroll in the first second, the angle, and why it serves the goal. ${project.brandId === null ? "This video has no brand: keep claims to what the person said, and ask them when unsure." : "Use meridian_brand for the brand's claims and words to avoid."}${style} ${how}`;
    case "script":
      return `${header} Write the script from the concept: ${settled(project, "concept")}. At most ${wordBudget(brief.seconds)} spoken words for ${brief.seconds} s, in ${brief.language}, beat by beat with seconds per beat, the hook first.${brief.voice.wanted ? ` Voice: ${brief.voice.tone}.` : " No voiceover: the words are on-screen text."}${style} In studio mode offer two or three versions as options. ${how}`;
    case "storyboard":
      return `${header} Turn the script into scenes that add up to ${brief.seconds} s: for each, the seconds, what is seen (a coded graphic, kinetic type, or an image to generate, with its prompt), the on-screen text, and the line spoken. Prefer coded visuals: they are free. ${how}`;
    case "assets":
      return `${header} From the storyboard, list what Meridian must make: ${brief.voice.wanted ? "the voiceover takes (one take for the whole script is cheapest; pick a model from meridian_voice_models and a voice), " : ""}each image to generate with its prompt, and what each holds on the budget (meridian_status: a voiceover or an image holds $1 and settles at the provider's own cost). Everything coded is free and not listed. ${how} Only after this is settled, make the assets with meridian_voiceover and meridian_image, passing projectId.`;
    case "build":
      return `${header} Write the HyperFrames composition (meridian_video_guide has the format) from the storyboard, with the asset files (meridian_files, projectId). Show a preview the person can watch if you can (an HTML artifact). ${how}`;
    case "render":
      return brief.render === "chat"
        ? `${header} Call meridian_render {renderer: "claude", fileIds} and run its commands in your code sandbox to make the MP4; share it with the person. Then resolve "render" with decidedBy "chat" and content: where the MP4 is.`
        : `${header} The person asked for the code and the files, not an MP4: give them the composition and meridian_render's links, then resolve "render" with decidedBy "chat".`;
    case "deliver":
      return `${header} Show the person the result: the MP4 or the code, the files, and what Meridian spent on this video (meridian_project). ${how}`;
  }
}

/** A short plan for the person: each phase and who settles it. */
export function planLines(mode: ProjectMode): string[] {
  return PHASES.map((phase) => `${PHASE_COPY[phase].label}: ${decidesFor(mode, phase) === "person" ? "you choose" : "the chat decides"}`);
}
