import { openSecret } from "../oauth/flow.ts";
import { stageAuditRecord } from "./evidence.ts";
import { reusableExternalId, type StoredExternalId } from "./ownership.ts";

/** Opens a sealed token, or the environment token when nothing is sealed. A sealed row that cannot be opened does not fall through. */
export function openAccessToken(input: {
  sealed: string;
  key: string;
  envToken: string;
}): { token: string; source: "sealed" | "environment" } | { error: string } {
  if (input.sealed.trim()) {
    if (!input.key.trim()) {
      return { error: "TOKEN_ENCRYPTION_KEY is not configured. The stored token was not opened and nothing was sent." };
    }
    try {
      const opened = openSecret(input.sealed, input.key);
      if (typeof opened !== "string") return opened;
      if (!opened.trim()) return { error: "The stored token was empty. Nothing was sent." };
      return { token: opened, source: "sealed" };
    } catch {
      return { error: "The stored token could not be read. Nothing was sent." };
    }
  }
  if (input.envToken.trim()) return { token: input.envToken, source: "environment" };
  return { error: "No access token is stored and none is configured. Nothing was sent." };
}

export type StageWrite = {
  objectType: string;
  idempotencyKey: string;
  externalId: string;
  responseText: string;
  action: "insert" | "keep";
};

/** Confirmed ids only. A different stored id is kept. Another workspace throws before anything is written. */
export function stageWrites(input: {
  organizationId: string;
  brandId: string;
  creativeId: string;
  existing: StoredExternalId[];
  stages: { objectType: string; status: string; externalId: string | null; responseText: string }[];
}): StageWrite[] {
  const writes: StageWrite[] = [];
  for (const stage of input.stages) {
    const idempotencyKey = `${input.brandId}:${input.creativeId}:${stage.objectType}`;
    const prior = reusableExternalId(input.existing, input.organizationId, idempotencyKey);
    const confirmed = stageAuditRecord({
      status: stage.status,
      externalId: stage.externalId,
      responseText: stage.responseText,
    });
    if (!confirmed.persist) continue;
    if (prior && prior !== confirmed.externalId) {
      writes.push({
        objectType: stage.objectType,
        idempotencyKey,
        externalId: prior,
        responseText: confirmed.responseText,
        action: "keep",
      });
      continue;
    }
    writes.push({
      objectType: stage.objectType,
      idempotencyKey,
      externalId: confirmed.externalId,
      responseText: confirmed.responseText,
      action: prior ? "keep" : "insert",
    });
  }
  return writes;
}
