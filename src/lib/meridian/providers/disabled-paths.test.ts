// The disabled paths, called through their production defaults. No transport or fetch is injected, so each call takes the gate that
// production takes. A counting fetch stands in for the network: every test asserts it was never called, so a disabled path sends nothing
// and repeats nothing. No test reaches the network.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { embedExternal } from "../embeddings/external.ts";
import { realEmailProvider } from "../notifications/email.ts";
import { generateNanoBananaImage } from "./nano-banana.server.ts";

let requests: number;

beforeEach(() => {
  requests = 0;
  mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("A disabled path reached the network.");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("disabled paths send nothing through their production defaults", () => {
  test("the image adapter refuses with NOT_CONNECTED and sends no request, even with a key", async () => {
    const result = await generateNanoBananaImage({ prompt: "A product on a table", promptVersion: "test.v1", apiKey: "fixture-key-not-real" });
    assert.equal(result.status, "NOT_CONNECTED");
    assert.match(result.error, /nothing was sent/);
    assert.equal(requests, 0);
  });

  test("the embeddings call refuses through its default transport and sends no request", async () => {
    await assert.rejects(embedExternal(["one fixture sentence"], { env: { url: "https://embeddings.example.test/v1", key: "fixture-key-not-real" } }), /No vector was stored/);
    assert.equal(requests, 0);
  });

  test("the email send refuses through its default transport, reports it was not sent, and sends no request", async () => {
    const provider = realEmailProvider({ url: "https://email.example.test/send", key: "fixture-key-not-real" });
    const result = await provider.send({ to: "reviewer@example.test", subject: "Fixture", text: "Fixture body" } as never);
    assert.notEqual(result.status, "SENT");
    assert.equal(requests, 0);
  });
});
