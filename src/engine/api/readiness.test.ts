// The engine's readiness, as a start reads it (Content Factory and the Factory). A run is refused, with each reason, when the workspace's shot
// storage or its speech-to-text is not connected, so a run is not queued where it would be held at its first shot or analysis.

import assert from "node:assert/strict";
import { test } from "node:test";
import { engineReadiness, stagesNeeded, type EngineReadinessPorts } from "./index.ts";

function ports(overrides: Partial<EngineReadinessPorts> & { deepgram?: "ready" | "not_connected"; storage?: string | null } = {}): EngineReadinessPorts {
  const stub = { async run() { throw new Error("not run by this test"); } };
  const credentials: EngineReadinessPorts["credentials"] = {
    get: async (credentialId) => {
      if (credentialId === "deepgram" && overrides.deepgram === "not_connected") return { status: "not_connected", reason: "no Deepgram key is saved" };
      return { status: "ready", credential: { kind: "api_key", secret: "fixture-not-a-key" } };
    },
  };
  return {
    monthBudget: { monthBudget: async () => ({ status: "known", usd: 100 }) },
    credentials,
    runtime: { handlers: Object.fromEntries(stagesNeeded(0).map((stage) => [stage, stub])) as EngineReadinessPorts["runtime"]["handlers"] },
    ...(overrides.storage === undefined ? {} : { shotConnection: async () => overrides.storage ?? null }),
  } as EngineReadinessPorts;
}

test("a workspace whose media functions or Drive are not connected is not ready, and the reason is named", async () => {
  const readiness = await engineReadiness("ws_ready", ports({ storage: "Google Drive is not connected for this workspace" }), { variantCount: 0 });
  assert.equal(readiness.status, "not_connected");
  assert.ok(readiness.status === "not_connected" && readiness.reasons.some((reason) => reason.includes("Google Drive is not connected")));
});

test("a run with a reference needs speech-to-text: without a Deepgram key it is not ready, and the reason says so", async () => {
  const withSpeech = await engineReadiness("ws_ready", ports({ deepgram: "not_connected" }), { variantCount: 0, speech: true });
  assert.equal(withSpeech.status, "not_connected");
  assert.ok(withSpeech.status === "not_connected" && withSpeech.reasons.some((reason) => reason.startsWith("Speech-to-text (Deepgram)")));

  const withoutSpeech = await engineReadiness("ws_ready", ports({ deepgram: "not_connected" }), { variantCount: 0 });
  assert.equal(withoutSpeech.status, "ready", "a run that does not ask for speech is not held by the speech key");
});

test("with the storage and speech connected, and every stage registered, a run is ready", async () => {
  const readiness = await engineReadiness("ws_ready", ports({ storage: null }), { variantCount: 0, speech: true });
  assert.deepEqual(readiness, { status: "ready" });
});
