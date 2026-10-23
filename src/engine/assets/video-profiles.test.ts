import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, gatewayFor, json, scripted } from "./test/recorded.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { noEligibleVideoModel, videoProfileLoader } from "./video-profiles.ts";

const LISTING = "GET /api/v1/videos/models";
const KLING = "kwaivgi/kling-v3.0-std";
const BUDGET = "vendor/budget-clip";

test("a listing yields a profile for each video model it names; a model it does not name is simply absent", async () => {
  const script = scripted({ [LISTING]: json(200, fixture("video-models.json")) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const profiles = await loader.loadVideoProfiles("org_1");
  assert.deepEqual(profiles.get(KLING)?.durations, [5, 10]);
  assert.equal(profiles.get(KLING)?.capabilities.firstFrame, true);
  assert.equal(profiles.get(BUDGET), undefined, "the recorded listing does not name the budget model, and nothing is guessed for it");
  assert.deepEqual(loader.gapsFor("org_1").map((gap) => gap.model), ["broken/entry"], "the one entry of the recording that does not parse is the only gap");
  assert.equal(script.requests.length, 1, "one listing read, through the gateway");
});

test("a listing that fails yields no profile, with the reason on the listing; the next call reads again", async () => {
  const script = scripted({ [LISTING]: [json(500, { error: "unavailable" }), json(200, fixture("video-models.json"))] });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const first = await loader.loadVideoProfiles("org_1");
  assert.equal(first.size, 0);
  const gaps = loader.gapsFor("org_1");
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0]?.reason.startsWith("GET /videos/models could not be read: "));
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
  assert.deepEqual(loader.gapsFor("org_1").map((gap) => gap.reason), ["GET /videos/models could not be read: the listing has no data array"]);
});

test("an entry the listing names but that has no supported durations is left out with that reason", async () => {
  const listing = { data: [{ id: KLING }, { id: BUDGET, supported_durations: [5] }] };
  const script = scripted({ [LISTING]: json(200, listing) });
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport) });
  const profiles = await loader.loadVideoProfiles("org_1");
  assert.equal(profiles.has(BUDGET), true);
  assert.equal(profiles.has(KLING), false);
  assert.deepEqual(loader.gapsFor("org_1"), [{ model: KLING, reason: `GET /videos/models lists ${KLING}, but no supported durations` }]);
});

test("a video class with no profile is refused with the gaps' reasons; an image class is never refused here", () => {
  const profile = videoProfilesFromListing(fixture("video-models.json")).profiles.get(KLING);
  if (profile === undefined) throw new Error("the fixture has no kling profile");
  assert.deepEqual(noEligibleVideoModel({ modelClass: "video.cinematic", profiles: new Map(), gaps: [{ model: KLING, reason: "why" }] }), ["why"]);
  assert.equal(noEligibleVideoModel({ modelClass: "video.cinematic", profiles: new Map([[KLING, profile]]), gaps: [] }), null);
  assert.deepEqual(noEligibleVideoModel({ modelClass: "video.i2v_pinned", profiles: new Map(), gaps: [] }), [
    "GET /videos/models named no video model with a profile, so video.i2v_pinned has no model to call",
  ]);
  assert.equal(noEligibleVideoModel({ modelClass: "image.keyframe", profiles: new Map(), gaps: [] }), null);
});

test("a switched-off family has no profile, with its reason; the families are read on every load, and the listing is kept", async () => {
  const VEO = "google/veo-3.1";
  const script = scripted({ [LISTING]: json(200, fixture("video-models.json")) });
  let families: string[] = ["google/veo"];
  const loader = videoProfileLoader({ gateway: gatewayFor(script.transport), familiesFor: async () => families });

  const off = await loader.loadVideoProfiles("org_1");
  assert.equal(off.has(VEO), false, "Veo has no profile while its family is switched off, so no route can call it");
  assert.equal(off.has(KLING), true, "the other models keep their profiles");
  assert.deepEqual(
    loader.gapsFor("org_1").filter((gap) => gap.model === VEO),
    [{ model: VEO, reason: `${VEO} is switched off by the workspace's model policy` }],
  );

  families = [];
  const on = await loader.loadVideoProfiles("org_1");
  assert.equal(on.has(VEO), true, "Veo is back once its family is switched on");
  assert.equal(script.requests.length, 1, "the listing is kept; only the policy is read again");
});
