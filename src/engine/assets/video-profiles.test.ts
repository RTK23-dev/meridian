import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, gatewayFor, json, scripted } from "./test/recorded.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { noEligibleVideoModel, routedVideoModels, videoProfileLoader } from "./video-profiles.ts";

const LISTING = "GET /api/v1/videos/models";

/** The OpenRouter model a video class routes to, read from the route table (the tests name no model themselves). */
function routedModelOf(capability: "video.cinematic" | "video.budget"): string {
  const route = gatewayFor(scripted({}).transport)
    .routes(capability)
    .find((candidate) => candidate.provider.id === "openrouter");
  if (route === undefined) throw new Error(`${capability} routes no OpenRouter model`);
  return route.model;
}

/** The first routed model (video.cinematic) is named by the recorded listing; the second (video.budget) is not. */
const KLING = routedModelOf("video.cinematic");
const VEO_LITE = routedModelOf("video.budget");

test("the routed video models are the route table's: one for video.cinematic and one for video.budget, each once", () => {
  const gateway = gatewayFor(scripted({}).transport);
  assert.deepEqual(routedVideoModels(gateway), [KLING, VEO_LITE]);
});

test("a listing that names the route's model yields its profile; a model the listing does not name is left out with its reason", async () => {
  const script = scripted({ [LISTING]: json(200, fixture("video-models.json")) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const profiles = await loader.loadVideoProfiles("org_1");
  assert.deepEqual(profiles.get(KLING)?.durations, [5, 10]);
  assert.equal(profiles.get(KLING)?.capabilities.firstFrame, true);
  assert.equal(profiles.get(VEO_LITE), undefined, "the recorded listing does not name the budget model");
  assert.deepEqual(loader.gapsFor("org_1"), [{ model: VEO_LITE, reason: `GET /videos/models does not name ${VEO_LITE}` }]);
  assert.equal(script.requests.length, 1, "one listing read, through the gateway");
});

test("a listing that fails yields no profile, with the reason on every routed model; the next call reads again", async () => {
  const script = scripted({ [LISTING]: [json(500, { error: "unavailable" }), json(200, fixture("video-models.json"))] });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const first = await loader.loadVideoProfiles("org_1");
  assert.equal(first.size, 0);
  const gaps = loader.gapsFor("org_1");
  assert.deepEqual(gaps.map((gap) => gap.model), [KLING, VEO_LITE]);
  assert.ok(gaps.every((gap) => gap.reason.startsWith("GET /videos/models could not be read: ")));
  assert.match(gaps[0]?.reason ?? "", /500/);
  const second = await loader.loadVideoProfiles("org_1");
  assert.equal(second.get(KLING)?.durations.length, 2, "the failed read was not kept");
  assert.equal(script.requests.length, 2);
});

test("a listing that was read is kept for its workspace: a second load for the workspace makes no request", async () => {
  const script = scripted({ [LISTING]: json(200, fixture("video-models.json")) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  await loader.loadVideoProfiles("org_1");
  await loader.loadVideoProfiles("org_1");
  assert.equal(script.requests.length, 1);
  await loader.loadVideoProfiles("org_2");
  assert.equal(script.requests.length, 2, "another workspace reads its own listing");
});

test("without a workspace key the listing is NOT_CONNECTED with its reason, and no request is sent", async () => {
  const script = scripted({});
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport, { keys: {} }) });
  const profiles = await loader.loadVideoProfiles("org_1");
  assert.equal(profiles.size, 0);
  const gaps = loader.gapsFor("org_1");
  assert.ok(gaps.length > 0);
  assert.ok(gaps.every((gap) => gap.reason.startsWith("NOT_CONNECTED: GET /videos/models cannot be read")));
  assert.equal(script.requests.length, 0);
});

test("a listing with no data array is a failed read, not an empty catalogue", async () => {
  const script = scripted({ [LISTING]: json(200, { models: [] }) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  assert.equal((await loader.loadVideoProfiles("org_1")).size, 0);
  assert.deepEqual(
    loader.gapsFor("org_1").map((gap) => gap.reason),
    [`GET /videos/models could not be read: the listing has no data array`, `GET /videos/models could not be read: the listing has no data array`],
  );
});

test("an entry the listing names but that has no supported durations is left out with that reason", async () => {
  const listing = { data: [{ id: KLING }, { id: VEO_LITE, supported_durations: [5] }] };
  const script = scripted({ [LISTING]: json(200, listing) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const profiles = await loader.loadVideoProfiles("org_1");
  assert.equal(profiles.has(VEO_LITE), true);
  assert.equal(profiles.has(KLING), false);
  assert.deepEqual(loader.gapsFor("org_1"), [{ model: KLING, reason: `GET /videos/models lists ${KLING}, but no supported durations` }]);
});

test("a video class with no profile for any routed model is refused with each reason; an image class is never refused here", () => {
  const gateway = gatewayFor(scripted({}).transport);
  const profile = videoProfilesFromListing(fixture("video-models.json")).profiles.get(KLING);
  if (profile === undefined) throw new Error("the fixture has no kling profile");
  assert.deepEqual(noEligibleVideoModel({ gateway, modelClass: "video.cinematic", profiles: new Map(), gaps: [{ model: KLING, reason: "why" }] }), ["why"]);
  assert.equal(noEligibleVideoModel({ gateway, modelClass: "video.cinematic", profiles: new Map([[KLING, profile]]), gaps: [] }), null);
  assert.deepEqual(noEligibleVideoModel({ gateway, modelClass: "video.i2v_pinned", profiles: new Map(), gaps: [] }), [
    "video.i2v_pinned has no OpenRouter model routed, so no video model can be called",
  ]);
  assert.equal(noEligibleVideoModel({ gateway, modelClass: "image.keyframe", profiles: new Map(), gaps: [] }), null);
});
