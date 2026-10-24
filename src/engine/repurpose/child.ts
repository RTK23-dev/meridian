// The child cut of a repurposed variation: the master's EDL with only its visual treatment changed (contract v11). Its id is derived from the
// master and the variation's key, so a retry names the same child. The master is never changed.

import { edlSchema, type EditDecisionList, type VisualTreatment } from "../contracts/index.ts";
import { stableId } from "../jobs/stable-id.ts";

export function repurposedEdl(master: EditDecisionList, visual: VisualTreatment, variationKey: string): EditDecisionList {
  const edlId = stableId("edl_", `repurpose|${master.edlId}|${variationKey}`);
  return edlSchema.parse({ ...structuredClone(master), edlId, variantOf: master.edlId, visual });
}
