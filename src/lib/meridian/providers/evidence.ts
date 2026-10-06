import { redactSecrets } from "../observability/redact.ts";
import { confirmedExternalId } from "./ownership.ts";

/** Persist a stage only when the provider confirmed an id. The stored text is redacted. */
export function stageAuditRecord(input: {
  status: string;
  externalId: string | null;
  responseText: string;
}): { persist: false; reason: string } | { persist: true; externalId: string; responseText: string } {
  const id = confirmedExternalId(input.status, input.externalId);
  if (!id) return { persist: false, reason: "No confirmed provider id. Nothing was stored." };
  return { persist: true, externalId: id, responseText: redactSecrets(input.responseText).slice(0, 2000) };
}
