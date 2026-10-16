import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoleAnswerError } from "../claude/errors.ts";
import { FIXTURE_IDS, productionRequestFixture, WORKSPACE_ID } from "../contracts/fixtures/index.ts";
import { classifyVisualRequests, visualRequestsOf, type VisualRequestRef } from "./classify.ts";
import { BLENDER, depsWith, recordedAnswer, sentText } from "./test/helpers.ts";

const REQUESTS: VisualRequestRef[] = [{ beatId: "b3", want: BLENDER, strength: "must" }];

function classifyInput(requests: VisualRequestRef[] = REQUESTS) {
  return { requestId: FIXTURE_IDS.request, workspaceId: WORKSPACE_ID, reservationId: FIXTURE_IDS.reservation, attempt: 1, requests };
}

describe("the request classifier (7.3)", () => {
  it("returns the recorded properties of every request, in request order, with the request's text", async () => {
    const { deps, requests } = await depsWith([recordedAnswer("openrouter-request-classifier-ok")], 4);
    const outcome = await classifyVisualRequests(deps, classifyInput());
    assert.equal(outcome.status, "classified");
    if (outcome.status !== "classified") return;
    assert.deepEqual(outcome.classifications, [{ beatId: "b3", want: BLENDER, properties: ["real_product"] }]);
    assert.equal(requests.length, 1, "one call for the request");
    assert.match(sentText(requests[0]?.body), /untrusted-data name="requests"/, "the request text travels as an untrusted block");
  });

  it("reads the requests of a production request in the order it gives them", () => {
    assert.deepEqual(visualRequestsOf(productionRequestFixture), [{ beatId: "b3", want: BLENDER, strength: "must" }]);
  });

  it("makes no call for a request with no visual requests", async () => {
    const { deps, requests } = await depsWith([], 4);
    const outcome = await classifyVisualRequests(deps, classifyInput([]));
    assert.deepEqual(outcome, { status: "classified", classifications: [], calls: [], alerts: [] });
    assert.equal(requests.length, 0);
  });

  it("does not guess when the budget refuses the call: the outcome says why, and nothing is sent", async () => {
    const { deps, requests } = await depsWith([recordedAnswer("openrouter-request-classifier-ok")], 0);
    const outcome = await classifyVisualRequests(deps, classifyInput());
    assert.equal(outcome.status, "not_classified");
    if (outcome.status !== "not_classified") return;
    assert.match(outcome.reason, /refused/);
    assert.equal(requests.length, 0, "no call was made");
  });

  it("fails the stage when the answer breaks its contract twice, and never uses the answer", async () => {
    const { deps } = await depsWith([recordedAnswer("openrouter-planner-ok"), recordedAnswer("openrouter-planner-ok")], 4);
    await assert.rejects(classifyVisualRequests(deps, classifyInput()), (error: unknown) => error instanceof RoleAnswerError);
  });
});
