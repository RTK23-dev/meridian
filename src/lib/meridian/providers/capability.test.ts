// The disabled capabilities and the shared retry rule. No test reaches the network: a counting transport answers every request.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CapabilityDisabledError, DISABLED_CAPABILITIES, gatedFetch, gatedTransport, isCapabilityDisabledError, type DisabledCapability } from "./capability.ts";
import { sendWithRetry, type Transport, type TransportRequest, type TransportResponse } from "./http.ts";

const CAPABILITIES = Object.keys(DISABLED_CAPABILITIES) as DisabledCapability[];

function answering(statuses: number[]): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
    const response: TransportResponse = { status, body: JSON.stringify({ ok: status < 300 }), headers: {} };
    return response;
  };
  return { transport, calls };
}

function request(method: TransportRequest["method"], url = "https://graph.example.test/object"): TransportRequest {
  return { method, url, headers: {} };
}

const noSleep = async () => {};

describe("disabled capabilities", () => {
  test("every disabled capability has a reason that names what is missing", () => {
    for (const capability of CAPABILITIES) {
      assert.ok(DISABLED_CAPABILITIES[capability].length > 20, `${capability} has a reason`);
    }
  });

  test("the gated transport of each capability refuses without an answer, and names the capability", async () => {
    for (const capability of CAPABILITIES) {
      await assert.rejects(gatedTransport(capability)(request("POST")), (error: unknown) => {
        assert.ok(isCapabilityDisabledError(error), `${capability} throws the disabled error`);
        assert.equal((error as CapabilityDisabledError).capability, capability);
        assert.match((error as Error).message, /nothing was sent/);
        return true;
      });
    }
  });

  test("the gated fetch of each capability refuses without a network call", async () => {
    for (const capability of CAPABILITIES) {
      await assert.rejects(gatedFetch(capability)("https://example.test/", { method: "POST" }), CapabilityDisabledError);
    }
  });

  test("a disabled capability is sent once, with no retry and no wait, and reports that nothing was sent", async () => {
    let sleeps = 0;
    const result = await sendWithRetry(gatedTransport("email.send"), request("POST"), {
      idempotent: true,
      sleep: async () => {
        sleeps += 1;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 1);
    assert.equal(sleeps, 0);
    assert.match(result.error, /nothing was sent/);
  });
});

describe("the shared retry rule", () => {
  test("a GET that fails with 500 is repeated up to the attempt limit", async () => {
    const { transport, calls } = answering([500, 500, 500]);
    const result = await sendWithRetry(transport, request("GET"), { sleep: noSleep });
    assert.equal(calls.length, 3);
    assert.equal(result.status, 500);
  });

  test("a POST that fails with 500 is sent once: its outcome is unknown, and a repeat could write or charge twice", async () => {
    const { transport, calls } = answering([500, 200]);
    const result = await sendWithRetry(transport, request("POST"), { sleep: noSleep });
    assert.equal(calls.length, 1);
    assert.equal(result.status, 500);
    assert.equal(result.ok, false);
  });

  test("a POST that fails with 429 is also sent once, because the rate limit can follow an accepted request", async () => {
    const { transport, calls } = answering([429, 200]);
    const result = await sendWithRetry(transport, request("POST"), { sleep: noSleep });
    assert.equal(calls.length, 1);
    assert.equal(result.status, 429);
  });

  test("a POST whose connection drops is sent once and reported as failed, with no second request", async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls += 1;
      throw new Error("connection reset");
    };
    const result = await sendWithRetry(transport, request("POST"), { sleep: noSleep });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.error, /connection reset/);
  });

  test("a POST the caller marks idempotent is repeated, because the provider keys its writes", async () => {
    const { transport, calls } = answering([500, 500, 200]);
    const result = await sendWithRetry(transport, request("POST"), { idempotent: true, sleep: noSleep });
    assert.equal(calls.length, 3);
    assert.equal(result.ok, true);
  });

  test("a 4xx other than 429 is the provider's answer and is not repeated, for any method", async () => {
    const { transport, calls } = answering([400, 200]);
    const result = await sendWithRetry(transport, request("GET"), { sleep: noSleep });
    assert.equal(calls.length, 1);
    assert.equal(result.status, 400);
  });
});
