// The live port's mapping, with the generation call replaced: no provider is called and nothing is written.

import assert from "node:assert/strict";
import test from "node:test";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import type { Sql } from "../learning/store.ts";
import type { completeWithModel } from "../providers/chat.server.ts";
import { liveDirectionPort } from "./live.server.ts";
import type { ModelCall } from "./pipeline.ts";

const CHOICE: TextModelChoice = { id: "vendor/writer-1", name: "Writer 1", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000005, inputModalities: ["text"], contextLength: 200_000 };
const CALL: ModelCall = { step: "concept_lab", slot: "writer_a", promptId: "concept_lab@1", promptHash: "sha256:x", system: "# concept_lab@1", user: "data", temperature: 1, maxTokens: 3200 };
const SQL = {} as Sql;

function context() {
  return { organizationId: "org_1", brandId: "brand_1", sql: SQL, correlationId: "run_1", inputRef: "session_1", slots: { writer_a: { model: CHOICE.id, choice: CHOICE } } };
}

test("a call goes to the slot's model with the prompt, the limits and a ledger record of its step", async () => {
  const seen: Parameters<typeof completeWithModel>[] = [];
  const port = liveDirectionPort(context(), async (...args) => {
    seen.push(args);
    return { ok: true, content: "{}", latencyMs: 10, tokens: 100, provider: "openrouter", model: CHOICE.id, modelSource: "workspace", returnedModel: "vendor/writer-1-0915", generationId: "gen_1", costUsd: 0.0021 };
  });
  const reply = await port.complete(CALL);
  assert.deepEqual(reply, { ok: true, content: "{}", model: "vendor/writer-1-0915", costUsd: 0.0021 });
  const [organizationId, input] = seen[0]!;
  assert.equal(organizationId, "org_1");
  assert.equal(input.model, CHOICE.id);
  assert.equal(input.system, "# concept_lab@1");
  assert.equal(input.maxTokens, 3200);
  assert.equal(input.temperature, 1);
  assert.deepEqual(
    { ...input.record, sql: undefined },
    { sql: undefined, brandId: "brand_1", correlationId: "run_1", operation: "direction.concept_lab", promptId: "concept_lab", promptVersion: "1", inputRef: "session_1" },
  );
});

test("a slot with no model sends nothing, and a failed or uncertain call is a failure with its status", async () => {
  let sent = 0;
  const port = liveDirectionPort(context(), async () => {
    sent += 1;
    return { ok: false, status: "uncertain", provider: "openrouter", error: "The call timed out; its hold stays until an administrator releases it.", model: CHOICE.id };
  });
  assert.deepEqual(await port.complete({ ...CALL, slot: "judge" }), { ok: false, error: 'No model is chosen for the "judge" slot, so nothing was sent.', billed: "no" });
  assert.equal(sent, 0);
  const reply = await port.complete(CALL);
  assert.equal(reply.ok, false);
  assert.match(reply.ok ? "" : reply.error, /^uncertain: The call timed out/);
  assert.equal(reply.ok ? null : reply.billed, "unknown", "an uncertain call may have been billed");
});

test("a call the generation path refused before sending is reported as not billed", async () => {
  const port = liveDirectionPort(context(), async () => ({ ok: false, status: "unavailable", provider: "openrouter", error: "Over the per-call ceiling. Nothing was sent.", model: CHOICE.id }));
  const reply = await port.complete(CALL);
  assert.deepEqual(reply, { ok: false, error: "unavailable: Over the per-call ceiling. Nothing was sent.", billed: "no" });
});
