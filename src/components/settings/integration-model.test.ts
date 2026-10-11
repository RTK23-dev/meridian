import assert from "node:assert/strict";
import test from "node:test";
import { integrationCards, lastSuccessFact, type SystemStatus } from "./integration-model.ts";

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    worker: "stopped",
    scheduler: "stopped",
    database: "up",
    objectStorage: { database: "MIGRATION_SOURCE", active: "filesystem", external: "NOT_CONFIGURED", detail: "Not configured." },
    embeddings: { status: "NOT_CONNECTED", provider: "", detail: "No external embeddings API is connected." },
    localSemantic: { status: "AVAILABLE", provider: "local-minilm", model: "Xenova/all-MiniLM-L6-v2", kind: "SEMANTIC_EMBEDDING", detail: "" },
    publishing: { status: "NOT_CONNECTED", detail: "" },
    providers: [],
    connections: [
      { provider: "meta", phase: "CONNECTED", detail: "ok", accountId: "123", accountName: "Acme", lastError: "", lastSuccessAt: "2026-03-01T10:00:00.000Z" },
      { provider: "tiktok", phase: "NOT_CONFIGURED", detail: "none", accountId: "", accountName: "", lastError: "", lastSuccessAt: null },
    ],
    integrations: [],
    email: { status: "NOT_CONFIGURED", detail: "Email delivery is not configured." },
    ...overrides,
  } as unknown as SystemStatus;
}

const loading = { state: "loading" as const };

test("the embeddings card names the variables the check reads, not OpenRouter", () => {
  const card = integrationCards({ status: status(), summaries: loading }).find((item) => item.id === "embeddings");
  assert.ok(card?.missing);
  assert.match(card.missing, /EXTERNAL_SEMANTIC_URL and EXTERNAL_SEMANTIC_KEY/);
  assert.doesNotMatch(card.missing, /OPENROUTER/);
});

test("a connected account shows its last successful request, and an account with none says so", () => {
  const cards = integrationCards({ status: status(), summaries: loading });
  const meta = cards.find((item) => item.id === "meta");
  const tiktok = cards.find((item) => item.id === "tiktok");
  assert.ok(meta?.facts.includes("Last successful request: " + new Date("2026-03-01T10:00:00.000Z").toLocaleString() + "."));
  assert.ok(tiktok?.facts.includes("No successful request is recorded yet."), "no recorded success is said, not a guessed time");
});

test("email delivery is reported from the server state", () => {
  const notConfigured = integrationCards({ status: status(), summaries: loading }).find((item) => item.id === "email");
  assert.equal(notConfigured?.status, "NOT_CONFIGURED");
  assert.equal(notConfigured?.missing?.includes("EMAIL_API_URL"), true);
  const configured = integrationCards({ status: status({ email: { status: "CONFIGURED", detail: "EMAIL_API_URL and EMAIL_API_KEY are set." } }), summaries: loading }).find((item) => item.id === "email");
  assert.equal(configured?.status, "AVAILABLE");
  assert.equal(configured?.missing, null);
  assert.equal(configured?.summary, "EMAIL_API_URL and EMAIL_API_KEY are set.");
});

test("the last-success line is plain when the time cannot be read", () => {
  assert.equal(lastSuccessFact("not a time"), "Last successful request: time not readable.");
});
