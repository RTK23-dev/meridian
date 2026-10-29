// The engine's readiness: whether it can run, and the production ports it reads. Moved out of engine/api/index.ts unchanged
// (coding loop, T8). index.ts re-exports the public names.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { ENGINE_STAGES, type EngineStage } from "../jobs/registry.ts";
import type { EngineRuntime } from "../jobs/types.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { CredentialSource } from "../gateway/types.ts";

// --- Readiness -------------------------------------------------------------------------------------------------------------

export type EngineReadinessPorts = {
  /** The workspace's monthly video budget (Settings). */
  monthBudget: WorkspaceBudgetSource;
  /** Meridian's credential resolver, as the gateway sees it. Only whether a key is connected is read, never the key. */
  credentials: CredentialSource;
  /** The runtime the worker runs engine jobs with. A stage without a handler cannot run. */
  runtime: Pick<EngineRuntime, "handlers">;
  /**
   * Why a shot cannot be made or stored in this workspace (the media functions, Drive), or null when it can. Production passes the shot
   * connection the shot stages check before any paid call; without it the storage is not checked here.
   */
  shotConnection?: (organizationId: string) => Promise<string | null>;
};

export type EngineReadiness = { status: "ready" } | { status: "not_connected"; reasons: string[] };

/** The stages one master needs. analyze_reference runs because no VideoDNA is handed over; variants only when variants are asked for. */

export function stagesNeeded(variantCount: number): EngineStage[] {
  return ENGINE_STAGES.filter((stage) => stage !== "variants" || variantCount > 0);
}

/**
 * Whether the engine can make a video for this workspace now. NOT_CONNECTED, with every reason, when the workspace has no monthly
 * video budget, when the OpenRouter key (every model route, OpenRouter is the default platform) or a render key (HeyGen
 * HyperFrames, or the Shotstack fallback) is not connected, or when a stage has no handler in the runtime. Nothing is called.
 */
export async function engineReadiness(
  organizationId: string,
  ports: EngineReadinessPorts,
  options: { variantCount?: number; now?: string; speech?: boolean } = {},
): Promise<EngineReadiness> {
  const reasons: string[] = [];
  const now = options.now ?? new Date().toISOString();
  const month = await ports.monthBudget.monthBudget({ organizationId, requestId: "", now }).catch(() => ({
    status: "not_connected" as const,
    reason: "the workspace monthly video budget could not be read",
  }));
  if (month.status !== "known") reasons.push(`Monthly video budget: ${month.reason}`);

  const lookup = async (credentialId: string) =>
    ports.credentials.get(credentialId, organizationId).catch(() => ({ status: "not_connected" as const, reason: `the ${credentialId} credential could not be checked` }));
  const openrouter = await lookup("openrouter");
  if (openrouter.status !== "ready") reasons.push(`OpenRouter: ${openrouter.reason}`);
  const heygen = await lookup("heygen");
  const shotstack = await lookup("shotstack");
  if (heygen.status !== "ready" && shotstack.status !== "ready") {
    reasons.push(`Render: neither HyperFrames (HeyGen) nor Shotstack is connected. ${heygen.reason}`);
  }

  // A shot is made and stored in the workspace's media functions and Drive, which the shot stages check only when they run. Checked here as well,
  // so a run is not queued where its first shot would be held for a reason the start could have named (review: truthful run states).
  if (ports.shotConnection !== undefined) {
    const storage = await ports.shotConnection(organizationId).catch(() => "the media functions or the workspace's Drive could not be checked");
    if (storage !== null) reasons.push(`Media and storage: ${storage}`);
  }
  // A reference video is analysed from its transcript, so a run with a reference needs speech-to-text (Deepgram) connected.
  if (options.speech === true) {
    const speech = await lookup("deepgram");
    if (speech.status !== "ready") reasons.push(`Speech-to-text (Deepgram): ${speech.reason}`);
  }
  const missing = stagesNeeded(options.variantCount ?? 0).filter((stage) => ports.runtime.handlers[stage] === undefined);
  if (missing.length > 0) reasons.push(`Engine stages with no handler in this deployment: ${missing.join(", ")}.`);
  return reasons.length === 0 ? { status: "ready" } : { status: "not_connected", reasons };
}

export async function productionReadinessPorts(sql: Sql): Promise<EngineReadinessPorts> {
  const [{ workspaceBudgetFromSettings, meridianMonthlyBudgetReader }, { meridianCredentialSource }, { productionComposition, productionEngineRuntime }] = await Promise.all([
    import("../jobs/workspace-budget.ts"),
    import("../gateway/meridian.ts"),
    import("../jobs/runtime.ts"),
  ]);
  return {
    monthBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
    credentials: meridianCredentialSource(),
    runtime: productionEngineRuntime(sql),
    // The same shot connection the shot stages check (media functions, Drive). The composition builds no connection; it only reads the deployment.
    shotConnection: productionComposition(sql).shotPorts?.shotConnection,
  };
}
