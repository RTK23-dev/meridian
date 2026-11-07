// The Models tab's view, kept free of React so it can be tested: the tasks in small groups, what each one uses now in a word or two, the
// models a set of tasks can share, and the catalogue grouped by provider for the picker. Nothing here reads or assumes a model works: the
// server's own state (getGenerationModels, getGenerationCatalogue) is what it describes.

export type CatalogueModel = {
  id: string;
  name: string;
  takes: string[];
  promptUsdPerMillionTokens: number;
  completionUsdPerMillionTokens: number;
  suitsTasks: string[];
};

export type TaskChoice = {
  task: string;
  label: string;
  description: string;
  needsImage: boolean;
  saved: { modelId: string; updatedAt: string; updatedBy: string } | null;
  deploymentDefault: string | null;
  /** What the task uses when nothing is chosen, when it has its own Auto. */
  auto: string | null;
};

/** The small groups the tasks are shown in. A task the server adds later and no group names goes to "More", never out of sight. */
export const TASK_GROUPS = [
  { id: "writing", label: "Writing", tasks: ["copy", "direction_writer", "direction_judge"] },
  { id: "research", label: "Research", tasks: ["research_analysis", "brain_suggest"] },
  { id: "images", label: "Images", tasks: ["vision", "reference_analysis"] },
] as const;

export type TaskGroup = { id: string; label: string; tasks: TaskChoice[] };

export function groupTasks(tasks: TaskChoice[]): TaskGroup[] {
  const named = new Set<string>(TASK_GROUPS.flatMap((group) => group.tasks));
  const groups: TaskGroup[] = TASK_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    tasks: group.tasks.flatMap((id) => tasks.filter((task) => task.task === id)),
  })).filter((group) => group.tasks.length > 0);
  const rest = tasks.filter((task) => !named.has(task.task));
  if (rest.length > 0) groups.push({ id: "more", label: "More", tasks: rest });
  return groups;
}

export type TaskState = "chosen" | "auto" | "default" | "unset";

/** What a task uses now: its chosen model, its own Auto, the deployment's default, or nothing (it sends nothing until one is chosen). */
export function taskState(task: TaskChoice): TaskState {
  if (task.saved) return "chosen";
  if (task.auto) return "auto";
  if (task.deploymentDefault) return "default";
  return "unset";
}

/** The sentence behind a task's info button for what it uses when nothing is chosen. */
export function fallbackText(task: TaskChoice): string {
  if (task.auto) return `Auto: ${task.auto}`;
  if (task.deploymentDefault) return `Without a choice, it uses the deployment's default, ${task.deploymentDefault}.`;
  if (task.needsImage) return "Without a choice, nothing reads images for this task: a model that takes images must be chosen.";
  return "Without a choice, nothing is sent for this task.";
}

/** How many tasks have a model chosen, and how many send nothing until one is. */
export function setupCounts(tasks: TaskChoice[]): { chosen: number; unset: number; of: number } {
  let chosen = 0;
  let unset = 0;
  for (const task of tasks) {
    const state = taskState(task);
    if (state === "chosen") chosen += 1;
    if (state === "unset") unset += 1;
  }
  return { chosen, unset, of: tasks.length };
}

/** The models every one of `tasks` can use, so one pick can be saved for all of them. */
export function sharedModels(models: CatalogueModel[], tasks: readonly string[]): CatalogueModel[] {
  if (tasks.length === 0) return [];
  return models.filter((model) => tasks.every((task) => model.suitsTasks.includes(task)));
}

/** The models one task can use. */
export function modelsFor(models: CatalogueModel[], task: string): CatalogueModel[] {
  return models.filter((model) => model.suitsTasks.includes(task));
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  "x-ai": "xAI",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  qwen: "Qwen",
  moonshotai: "Moonshot",
  "z-ai": "Z.ai",
  minimax: "MiniMax",
  cohere: "Cohere",
  amazon: "Amazon",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  "black-forest-labs": "Black Forest Labs",
  bytedance: "ByteDance",
};

/** The providers most workspaces pick from come first in the picker; the rest follow in alphabetical order. */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "deepseek"];

export function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : id;
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.split("-").map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part)).join(" ");
}

/** A model's name without the "Vendor: " prefix OpenRouter puts on it, since the picker already groups by vendor. Falls back to the id. */
export function shortName(model: { id: string; name: string } | null | undefined, id?: string): string {
  if (!model) return id ? (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id) : "";
  const trimmed = model.name.replace(/^[^:]{1,40}:\s*/, "").trim();
  return trimmed || model.id;
}

export function groupByProvider<T extends { id: string; name: string }>(models: T[]): Array<{ provider: string; label: string; models: T[] }> {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const provider = providerOf(model.id);
    const list = groups.get(provider) ?? [];
    list.push(model);
    groups.set(provider, list);
  }
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, label: providerLabel(provider), models: [...list].sort((a, b) => shortName(a).localeCompare(shortName(b))) }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.label.localeCompare(b.label));
}

/** A price per million tokens in a few characters. A model listed at zero says "free"; nothing is rounded to zero. */
export function usd(value: number): string {
  if (value === 0) return "free";
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** Input and output price per million tokens, as the catalogue states them. */
export function priceLine(model: Pick<CatalogueModel, "promptUsdPerMillionTokens" | "completionUsdPerMillionTokens">): string {
  return `${usd(model.promptUsdPerMillionTokens)} in · ${usd(model.completionUsdPerMillionTokens)} out per M`;
}

/**
 * The picker's search: every word typed must appear in the option's name or id (1), or it is hidden (0). cmdk's default scoring is
 * fuzzy, so "gemini" also matched "GPT-5 Mini openai/gpt-5-mini"; plain words show only what was asked for, in the provider order.
 */
export function matchesSearch(value: string, search: string): number {
  const haystack = value.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word)) ? 1 : 0;
}

export type BulkResult = { task: string; label: string; saved: boolean; reason: string | null };

/** One line for a multi-task save: how many saved, and each refusal with its reason. */
export function bulkSummary(results: BulkResult[], modelText: string): { line: string; refused: BulkResult[] } {
  const saved = results.filter((result) => result.saved);
  const refused = results.filter((result) => !result.saved);
  const tasks = (count: number) => `${count} task${count === 1 ? "" : "s"}`;
  if (refused.length === 0) return { line: `${modelText} set for ${tasks(saved.length)}.`, refused };
  if (saved.length === 0) return { line: `Nothing changed: ${modelText} was refused for every selected task.`, refused };
  return { line: `${modelText} set for ${saved.length} of ${tasks(results.length)}.`, refused };
}
