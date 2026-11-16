// The email provider's guard: one send per attempt, an Idempotency-Key on it, and an outcome that says whether the email may have gone out.
// Fixture transports only. No test reaches the network.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { realEmailProvider } from "./email.ts";

const ENV = { url: "https://email.example.test/send", key: "fixture-key-not-real" };
const MESSAGE = { to: "a@example.test", subject: "Fixture", text: "Body", idempotencyKey: "inv-1:1" };

function recording(answer: (call: number) => { status: number; body?: string } | Error) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const out = answer(calls.length);
    if (out instanceof Error) throw out;
    return { status: out.status, body: out.body ?? "{}", headers: {} };
  };
  return { transport, calls };
}

describe("realEmailProvider", () => {
  test("a 2xx is sent, with the idempotency key header", async () => {
    const { transport, calls } = recording(() => ({ status: 200, body: JSON.stringify({ id: "m1" }) }));
    const result = await realEmailProvider(ENV, transport).send(MESSAGE);
    assert.deepEqual(result, { status: "sent", provider: "real:email", id: "m1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers["idempotency-key"], "inv-1:1");
  });

  test("a 4xx is a clear refusal and is sent once", async () => {
    const { transport, calls } = recording(() => ({ status: 422 }));
    const result = await realEmailProvider(ENV, transport).send(MESSAGE);
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 1);
  });

  test("a 5xx is uncertain and is not repeated", async () => {
    const { transport, calls } = recording(() => ({ status: 503 }));
    const result = await realEmailProvider(ENV, transport).send(MESSAGE);
    assert.equal(result.status, "uncertain");
    assert.equal(calls.length, 1);
  });

  test("a thrown transport error (timeout) is uncertain and is not repeated", async () => {
    const { transport, calls } = recording(() => new Error("Provider request timed out after 30 seconds."));
    const result = await realEmailProvider(ENV, transport).send(MESSAGE);
    assert.equal(result.status, "uncertain");
    assert.equal(calls.length, 1);
  });

  test("without a URL or key it returns NOT_CONFIGURED and sends nothing", async () => {
    const { transport, calls } = recording(() => ({ status: 200 }));
    const result = await realEmailProvider({ url: "", key: "" }, transport).send(MESSAGE);
    assert.equal(result.status, "NOT_CONFIGURED");
    assert.equal(calls.length, 0);
  });
});
