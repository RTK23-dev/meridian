// The Hypit calls, each given the hypit.client gate the way the studio run gives it. The studio run (studio/hypit-run.ts) passes
// gatedTransport("hypit.client") as its default, and that is the gate these tests use. Reaching the studio run end to end needs a saved
// Hypit credential from the database, which this fixture does not have, so that path is not run here. Each call must report the gate's
// reason, not that the Hypit process failed to respond, because nothing was sent to it. Every request is counted.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { collectHypitArtifact, pollHypitJob, startHypitJob, type HypitConnection } from "../hypit/client.ts";
import { gatedTransport } from "../providers/capability.ts";

const GATE_MESSAGE = /off in this build, so nothing was sent/;

const connection: Extract<HypitConnection, { status: "CONFIGURED" }> = {
  status: "CONFIGURED",
  baseUrl: "https://hypit.example.test",
  token: "fixture-token-not-real",
};

let requests: number;

beforeEach(() => {
  requests = 0;
  mock.method(globalThis, "fetch", (async () => {
    requests += 1;
    throw new Error("The Hypit default path reached the network.");
  }) as typeof fetch);
});

afterEach(() => {
  mock.restoreAll();
});

describe("the Hypit calls fail closed through the hypit.client gate", () => {
  test("starting a job reports the gate's reason, sends no request, and does not claim a missing response", async () => {
    const result = await startHypitJob(connection, { meridianJobId: "job_default_gate" } as never, gatedTransport("hypit.client"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HYPIT_FAILED");
    assert.match(result.error, GATE_MESSAGE, "the failure names the gate");
    assert.doesNotMatch(result.error, /did not respond/, "nothing was sent, so no response was expected");
    assert.equal(requests, 0, "no request is sent to Hypit");
  });

  test("polling a job reports the gate's reason, sends no request, and does not claim a missing response", async () => {
    const result = await pollHypitJob(connection, "provider_job_default_gate", gatedTransport("hypit.client"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, GATE_MESSAGE, "the failure names the gate");
    assert.doesNotMatch(result.error, /did not respond/, "nothing was sent, so no response was expected");
    assert.equal(requests, 0, "no request is sent to Hypit");
  });

  test("collecting the artifact reports the gate's reason, sends no request, and does not claim a missing response", async () => {
    const result = await collectHypitArtifact(connection, "provider_job_default_gate", gatedTransport("hypit.client"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, GATE_MESSAGE, "the failure names the gate");
    assert.doesNotMatch(result.error, /did not return the artifact/, "nothing was sent, so no response was expected");
    assert.equal(requests, 0, "no request is sent to Hypit");
  });
});
