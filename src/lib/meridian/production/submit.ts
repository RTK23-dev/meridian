/**
 * The production submit boundary: the one place a creative spec is handed to a provider's `submitJob`.
 *
 * Preflight runs here, before the provider is called. A BLOCK returns the refusal with its reasons and the provider receives
 * nothing, so nothing is sent and nothing is spent. A PROCEED calls the provider once. The caller records a refusal on the job
 * and releases any budget it held for the submission.
 */
import { evaluateProductionPreflight, type PreflightResult } from "./preflight.ts";
import type { CreativeSpec, ProductionJob, ProductionProvider } from "./types.ts";

export type SubmitWithPreflightResult =
  | { refused: false; job: ProductionJob; preflight: PreflightResult }
  | { refused: true; preflight: PreflightResult; reasons: string[] };

export async function submitWithPreflight(
  provider: Pick<ProductionProvider, "submitJob">,
  spec: CreativeSpec,
): Promise<SubmitWithPreflightResult> {
  const preflight = evaluateProductionPreflight(spec);
  if (preflight.decision !== "PROCEED") {
    return { refused: true, preflight, reasons: preflight.reasons };
  }
  const job = await provider.submitJob(spec);
  return { refused: false, job, preflight };
}
