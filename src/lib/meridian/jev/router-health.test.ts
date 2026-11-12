import assert from "node:assert/strict";
import test from "node:test";
import { JevRouter, TypeSafeDirectJevProvider, transportHealth } from "./router.ts";

const ready = async () => ({ status: "ready" as const, secret: "tsk-fixture-0123456789", source: "workspace" as const, fingerprint: "…6789" });

test("a saved TypeSafe key is not READY while direct TypeSafe calls are switched off", async () => {
  const router = new JevRouter({ typesafeProvider: new TypeSafeDirectJevProvider({ lookup: ready as never }) });
  const health = await transportHealth(router.getProvider("typesafe_direct"), "org_a");
  assert.equal(health.status, "UNAVAILABLE");
  assert.match(health.message ?? "", /switched off/i);
  assert.match(health.message ?? "", /OpenRouter|Gemini/);
});

test("with a transport wired in, TypeSafe reports its own readiness", async () => {
  const router = new JevRouter({ typesafeProvider: new TypeSafeDirectJevProvider({ lookup: ready as never, fetchImpl: (async () => new Response("{}")) as typeof fetch }) });
  assert.equal((await transportHealth(router.getProvider("typesafe_direct"), "org_a")).status, "READY");
});
