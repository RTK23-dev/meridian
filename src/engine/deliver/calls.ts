// The Claude role calls of a request, as the manifest holds them (Bible 11, 16; Manifest v2 roleCalls). The journal (claude/journal.ts,
// stored by jobs/role-call-store.ts) has one entry for each paid call. A call that answered, or answered invalidly, becomes a
// ManifestRoleCall with its role. A refused call was never made and a pending call has no answer: neither is listed, and a pending
// one is counted (its cost is the held estimate in the ledger). The prompt version of each role is the one its calls used; two
// versions of one role in one request are refused, because the manifest names one per role. Pure.

import { claudeRoleSchema, EngineError, manifestRoleCallSchema, type ManifestRoleCall } from "../contracts/index.ts";
import type { JournalEntry } from "../claude/journal.ts";

export type RequestCalls = {
  roleCalls: ManifestRoleCall[];
  promptVersions: Record<string, string>;
  /** Calls that never returned an answer. Their cost is held in the ledger as the estimate. */
  unanswered: number;
};

export function requestCallsOf(entries: readonly JournalEntry[]): RequestCalls {
  const promptVersions: Record<string, string> = {};
  const roleCalls: ManifestRoleCall[] = [];
  let unanswered = 0;

  for (const entry of entries) {
    if (entry.status === "refused") continue;
    const seen = promptVersions[entry.role];
    if (seen !== undefined && seen !== entry.promptVersion) {
      throw new EngineError("internal", `the role ${entry.role} ran with two prompt versions (${seen}, ${entry.promptVersion}) in one request`, {
        stage: "deliver",
      });
    }
    promptVersions[entry.role] = entry.promptVersion;

    if (entry.status === "pending" || entry.call === null) {
      unanswered += 1;
      continue;
    }
    const role = claudeRoleSchema.safeParse(entry.role);
    if (!role.success) throw new EngineError("internal", `the journal holds an unknown role for call ${entry.idempotencyKey}`, { stage: "deliver" });
    const call = entry.call;
    // A role call with no provider bill has an unknown cost (contract v6). Its request is not delivered until the bill is recorded.
    if (call.costUsd === null) {
      throw new EngineError(
        "conflict",
        `the role call ${entry.idempotencyKey} has no settled cost, so the request is not delivered until its bill is recorded`,
        { stage: "deliver", retryable: false },
      );
    }
    const parsed = manifestRoleCallSchema.safeParse({
      role: role.data,
      promptVersion: call.promptVersion,
      model: call.model,
      answeredBy: call.answeredBy,
      generationId: call.generationId,
      tokens: { prompt: call.promptTokens, completion: call.completionTokens },
      costUsd: call.costUsd,
      verdict: call.verdict,
    });
    if (!parsed.success) {
      // A role call that does not fit the manifest contract is refused, and the request pauses (Bible 17.2, no fake success).
      const issue = parsed.error.issues[0];
      throw new EngineError(
        "internal",
        `the role call ${call.idempotencyKey} does not fit the manifest contract: ${issue ? issue.path.map(String).join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim(),
        { stage: "deliver" },
      );
    }
    roleCalls.push(parsed.data);
  }
  return { roleCalls, promptVersions, unanswered };
}
