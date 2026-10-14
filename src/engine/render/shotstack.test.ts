// Shotstack fallback (Bible 6.11, 9.3): the golden mapping of a component-free EDL, the refusal of a component EDL, the
// idempotency key, and the adapter and render flow over recorded responses through the gateway's transport. No request
// leaves the test. The responses are constructed from docs/engine/PROVIDER_APIS.md (see test/shotstackHarness.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EngineError, edlSchema, renderedVideoSchema, type GateResult } from "../contracts/index.ts";
import { edlFixture } from "../contracts/fixtures/index.ts";
import { routes } from "../config/routes.ts";
import { createGateway } from "../gateway/gateway.ts";
import { DEFAULT_PROVIDERS } from "../gateway/providers.ts";
import type { HttpTransport } from "../gateway/types.ts";
import {
  assertComponentFree,
  componentsUsedBy,
  createShotstackAdapter,
  isComponentFree,
  renderEdlWithShotstack,
  SHOTSTACK_BASE_URL,
  SHOTSTACK_LEDGER_MODEL,
  SHOTSTACK_LEDGER_PROVIDER,
  shotstackRenderKey,
  ShotstackRefusal,
  toShotstackTimeline,
} from "./shotstack.ts";
import {
  componentEdl,
  componentFreeEdl,
  credentialsFor,
  downloadExchange,
  DOWNLOAD_URL,
  errorExchange,
  EXPECTED_KEY,
  expectedBody,
  fixtureSourceUrl,
  ORG,
  pollExchange,
  reservedLedger,
  scriptedGateway,
  SS_RENDER_ID,
  shotstackDepsFor,
  submitExchange,
  SHOTSTACK_KEY,
} from "./test/shotstackHarness.ts";

const NOW = "2026-10-13T09:05:00.000Z";
const golden: unknown = JSON.parse(readFileSync(new URL("./test/fixtures/shotstack-timeline.golden.json", import.meta.url), "utf8"));

/** A copy of the component-free EDL with one extra clip on the given layer. */
function edlWithClip(clip: (typeof componentFreeEdl.tracks)[number]["clips"][number], layer: "base" | "graphics" = "graphics") {
  return {
    ...componentFreeEdl,
    tracks: [...componentFreeEdl.tracks, { layer, clips: [clip] }],
  };
}

describe("toShotstackTimeline (golden)", () => {
  it("maps the component-free EDL to the recorded golden timeline", () => {
    assert.deepEqual(toShotstackTimeline(componentFreeEdl, fixtureSourceUrl), golden);
  });

  it("is pure: the same EDL and URLs give the same mapping", () => {
    const first = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl);
    const second = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("draws the picture front first (captions, then base last) and the audio after it", () => {
    const { tracks } = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl).timeline;
    const picture = tracks.slice(0, 5);
    assert.equal(picture[0]?.clips[0]?.alias, "c_cap_1", "captions are the front track");
    assert.equal(picture[4]?.clips[1]?.alias, "c_base_2", "the base layer is the back track");
    for (const track of tracks.slice(5)) {
      for (const clip of track.clips) assert.equal(clip.asset.type, "audio", "audio tracks come after the picture");
    }
  });

  it("sets the output to mp4 at 1080 by 1920 and 30 fps, with times in seconds", () => {
    const { output } = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl);
    assert.deepEqual(output, { format: "mp4", size: { width: 1080, height: 1920 }, fps: 30 });
    const voice = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl).timeline.tracks.find((track) => track.clips[0]?.asset.type === "audio");
    assert.deepEqual(voice?.clips[0], {
      asset: { type: "audio", src: fixtureSourceUrl("store://voice/fixture-voice.wav"), volume: 1 },
      start: 0,
      length: 24,
    });
  });

  it("converts each gain from dB to a linear volume, the way the HyperFrames compiler does", () => {
    const sfx = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl).timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.asset.type === "audio" && clip.asset.src.includes("whoosh"));
    assert.equal(sfx.length, 2);
    for (const clip of sfx) {
      assert.ok(clip.asset.type === "audio" && Math.abs(clip.asset.volume - 10 ** (-6 / 20)) < 1e-12);
    }
  });

  it("packs overlapping sound effects onto separate audio tracks", () => {
    const audioTracks = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl).timeline.tracks.filter(
      (track) => track.clips[0]?.asset.type === "audio",
    );
    // voice, music, and two tracks for the two overlapping sound effects
    assert.equal(audioTracks.length, 4);
  });

  it("lists what Shotstack does not draw, and draws none of it", () => {
    const mapping = toShotstackTimeline(componentFreeEdl, fixtureSourceUrl);
    assert.deepEqual(mapping.dropped, [
      "box on c_pres_1 is not mapped (picture-in-picture)",
      "transition hard on c_base_1 is not mapped",
      "effect punch_in at 1200 ms is not mapped",
    ]);
    assert.ok(!JSON.stringify(mapping.timeline).includes("punch"), "no effect reaches the timeline");
    assert.ok(!JSON.stringify(mapping.timeline).includes("transitionIn"), "no transition reaches the timeline");
  });

  it("refuses an EDL that does not parse as an EDL, before mapping", () => {
    assert.throws(
      () => toShotstackTimeline({ ...componentFreeEdl, fps: 24 } as unknown as typeof componentFreeEdl, fixtureSourceUrl),
      (error) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("the component refusal (Bible 6.11 as amended)", () => {
  it("refuses an EDL with a custom component, with a typed error that sends it to review", () => {
    assert.throws(
      () => toShotstackTimeline(componentEdl, fixtureSourceUrl),
      (error) =>
        error instanceof ShotstackRefusal &&
        error instanceof EngineError &&
        error.kind === "invalid_input" &&
        error.retryable === false &&
        error.review === true &&
        JSON.stringify(error.components) === JSON.stringify(["captions.karaoke"]),
    );
  });

  it("names the components the EDL uses, sorted and without repeats", () => {
    const edl = edlSchema.parse({
      ...componentEdl,
      tracks: [
        ...componentEdl.tracks,
        { layer: "graphics", clips: [{ clipId: "g_1", startMs: 0, endMs: 1000, component: "product.card", props: {} }] },
        { layer: "graphics", clips: [{ clipId: "g_2", startMs: 1000, endMs: 2000, component: "product.card", props: {} }] },
      ],
    });
    assert.deepEqual(componentsUsedBy(edl), ["captions.karaoke", "product.card"]);
    assert.throws(() => assertComponentFree(edl), ShotstackRefusal);
  });

  it("is true only with no component clip", () => {
    assert.equal(isComponentFree(componentFreeEdl), true);
    assert.equal(isComponentFree(componentEdl), false);
    assert.equal(isComponentFree(edlFixture), false, "the chain fixture uses product.card, cta.card and captions.karaoke");
  });
});

describe("mapper refusals (typed, before any request)", () => {
  it("refuses a clip that has neither media nor text", () => {
    const edl = edlWithClip({ clipId: "c_empty", startMs: 0, endMs: 1000 });
    assert.throws(() => toShotstackTimeline(edl, fixtureSourceUrl), (error) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("refuses a media URI that is neither a video nor an image", () => {
    const edl = edlWithClip({ clipId: "c_gif", startMs: 0, endMs: 1000, srcUri: "store://takes/anim.gif" }, "base");
    assert.throws(() => toShotstackTimeline(edl, fixtureSourceUrl), (error) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("refuses two clips that overlap on one layer", () => {
    const edl = edlWithClip({ clipId: "c_overlap", startMs: 4000, endMs: 9000, srcUri: "store://takes/base-3.mp4" }, "base");
    assert.throws(() => toShotstackTimeline(edl, fixtureSourceUrl), (error) => error instanceof EngineError && /overlap/.test(error.message));
  });

  it("refuses a source with no URL, rather than sending a store:// URI", () => {
    assert.throws(
      () =>
        toShotstackTimeline(componentFreeEdl, (uri) => {
          throw new EngineError("internal", `no source URL was resolved for ${uri}`);
        }),
      EngineError,
    );
  });
});

describe("the Shotstack constants match the gateway's provider entry and route", () => {
  it("uses the render.fallback route's provider and model, and the provider's base URL", () => {
    const target = routes.table["render.fallback"].targets[0];
    assert.equal(target?.provider, SHOTSTACK_LEDGER_PROVIDER);
    assert.equal(target?.model, SHOTSTACK_LEDGER_MODEL);
    assert.equal(DEFAULT_PROVIDERS.shotstack.baseUrl, SHOTSTACK_BASE_URL);
    assert.deepEqual(DEFAULT_PROVIDERS.shotstack.auth, { kind: "api_key", header: "x-api-key", scheme: null });
  });
});

describe("shotstackRenderKey", () => {
  it("is the content hash of the timeline and output, built from the EDL's own URIs", () => {
    assert.match(EXPECTED_KEY, /^sha256:[0-9a-f]{64}$/);
    assert.equal(shotstackRenderKey(componentFreeEdl), EXPECTED_KEY);
  });

  it("changes when the timeline changes", () => {
    const moved = { ...componentFreeEdl, tracks: componentFreeEdl.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) })) };
    const base = moved.tracks[0];
    if (base?.clips[1]) base.clips[1].endMs = 15500;
    assert.notEqual(shotstackRenderKey(moved), EXPECTED_KEY);
  });
});

describe("ShotstackAdapter and renderEdlWithShotstack (recorded responses, through the gateway)", () => {
  it("submits with the key, polls through queued and rendering to done, and downloads without the key", async () => {
    const scripted = scriptedGateway([
      submitExchange({ body: expectedBody() }),
      pollExchange("queued"),
      pollExchange("rendering"),
      pollExchange("done", { url: DOWNLOAD_URL }),
      downloadExchange(),
    ]);
    const { ledger, reservationId } = await reservedLedger();
    const deps = shotstackDepsFor(scripted.gateway, ledger);

    const outcome = await renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, deps);

    assert.deepEqual(scripted.problems, []);
    assert.equal(scripted.remaining(), 0);
    assert.equal(outcome.renderId, SS_RENDER_ID);
    assert.equal(outcome.video.renderer, "shotstack");
    assert.equal(outcome.video.edlId, componentFreeEdl.edlId);
    assert.equal(outcome.video.idempotencyKey, EXPECTED_KEY);
    assert.equal(outcome.video.costUsd, 0.1, "no bill came back, so the cost is the hold, flagged as an estimate");
    assert.equal(outcome.resubmitted, false);
    assert.equal(outcome.dropped.length, 3);
    assert.deepEqual(deps.stored, [outcome.video.videoId]);
    renderedVideoSchema.parse(outcome.video);

    const entry = await ledger.getEntryByKey(EXPECTED_KEY);
    assert.equal(entry?.provider, "shotstack");
    assert.equal(entry?.model, "edit-v1");
    assert.equal(entry?.stage, "render");
    assert.equal(entry?.actualUsd, 0.1);
    assert.equal(entry?.actualIsEstimate, true);
  });

  it("sends the key on the submit and the polls, and the gateway attaches the key only on the provider host", async () => {
    const scripted = scriptedGateway([submitExchange({ body: expectedBody() }), pollExchange("done", { url: DOWNLOAD_URL }), downloadExchange()]);
    const { ledger, reservationId } = await reservedLedger();
    await renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(scripted.gateway, ledger));
    const [submit, poll, download] = scripted.seen;
    assert.equal(submit?.headers["x-api-key"], SHOTSTACK_KEY);
    assert.equal(submit?.headers["Idempotency-Key"], EXPECTED_KEY);
    assert.equal(poll?.headers["x-api-key"], SHOTSTACK_KEY);
    assert.equal(download?.headers["x-api-key"], undefined, "the download URL is not the provider's host");
    assert.equal(download?.url, DOWNLOAD_URL);
  });

  it("a resubmit of the same EDL with new signed URLs keeps the key, and the ledger reports a duplicate", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const first = scriptedGateway([submitExchange({ body: expectedBody() }), pollExchange("done", { url: DOWNLOAD_URL }), downloadExchange()]);
    await renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(first.gateway, ledger));

    const resigned = (uri: string) => `https://resigned.example.test/${uri.replace(/[^a-z0-9.]+/gi, "-")}?X-Amz-Signature=second`;
    const second = scriptedGateway([submitExchange({ body: expectedBody(resigned) }), pollExchange("done", { url: DOWNLOAD_URL }), downloadExchange()]);
    const outcome = await renderEdlWithShotstack(
      { reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW },
      shotstackDepsFor(second.gateway, ledger, { resolveSourceUrl: async (uri) => resigned(uri) }),
    );
    assert.deepEqual(first.problems, []);
    assert.deepEqual(second.problems, []);
    assert.equal(outcome.resubmitted, true);
    assert.equal(outcome.video.idempotencyKey, EXPECTED_KEY);
  });

  it("maps a failed render to a retryable provider error, keeps the hold as its estimate, and stores nothing", async () => {
    const scripted = scriptedGateway([
      submitExchange({ body: expectedBody() }),
      pollExchange("failed", { error: "Source media could not be fetched" }),
    ]);
    const { ledger, reservationId } = await reservedLedger();
    const deps = shotstackDepsFor(scripted.gateway, ledger);
    await assert.rejects(
      renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, deps),
      (error) =>
        error instanceof EngineError &&
        error.kind === "provider" &&
        error.retryable === true &&
        error.stage === "render" &&
        /could not be fetched/.test(error.message),
    );
    assert.deepEqual(scripted.problems, []);
    assert.deepEqual(deps.stored, []);
    assert.equal((await ledger.getEntryByKey(EXPECTED_KEY))?.actualUsd, 0.1);
  });

  it("refuses to run when Shotstack is not connected: a config error, and no request or ledger entry", async () => {
    const scripted = scriptedGateway([], {});
    const { ledger, reservationId } = await reservedLedger();
    await assert.rejects(
      renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(scripted.gateway, ledger)),
      (error) => error instanceof EngineError && error.kind === "config",
    );
    assert.equal(scripted.seen.length, 0);
    assert.equal(await ledger.getEntryByKey(EXPECTED_KEY), null);
  });

  it("maps a rate limit to a retryable error and an authentication failure to a non-retryable one", async () => {
    const limited = scriptedGateway([errorExchange("POST", `${SHOTSTACK_BASE_URL}/render`, 429, "Too many requests")]);
    const { ledger: first, reservationId: firstId } = await reservedLedger();
    await assert.rejects(
      renderEdlWithShotstack({ reservationId: firstId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(limited.gateway, first)),
      (error) => error instanceof EngineError && error.kind === "provider" && error.retryable === true,
    );

    const denied = scriptedGateway([errorExchange("POST", `${SHOTSTACK_BASE_URL}/render`, 401, "Invalid API key")]);
    const { ledger: second, reservationId: secondId } = await reservedLedger();
    await assert.rejects(
      renderEdlWithShotstack({ reservationId: secondId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(denied.gateway, second)),
      (error) => error instanceof EngineError && error.kind === "provider" && error.retryable === false && /authentication failed/.test(error.message),
    );
  });

  it("turns a dropped connection into a retryable provider error", async () => {
    const dropped: HttpTransport = async () => {
      throw new TypeError("fetch failed");
    };
    const gateway = createGateway({ transport: dropped, credentials: credentialsFor({ shotstack: SHOTSTACK_KEY }) });
    const adapter = createShotstackAdapter({
      transport: gateway.transportFor("shotstack", ORG),
      connection: () => gateway.connection("shotstack", ORG),
    });
    await assert.rejects(
      adapter.submit({ idempotencyKey: EXPECTED_KEY, title: "t", body: expectedBody() }),
      (error) => error instanceof EngineError && error.kind === "provider" && error.retryable === true && /did not complete/.test(error.message),
    );
  });

  it("refuses a download URL that is not https, and sends nothing", async () => {
    const scripted = scriptedGateway([]);
    const { gateway } = scripted;
    const adapter = createShotstackAdapter({ transport: gateway.transportFor("shotstack", ORG), connection: () => gateway.connection("shotstack", ORG) });
    await assert.rejects(
      adapter.fetchResult({ renderId: SS_RENDER_ID, status: "completed", videoUrl: "http://insecure.example.test/render.mp4" }),
      (error) => error instanceof EngineError && error.kind === "provider" && error.retryable === false,
    );
    assert.equal(scripted.seen.length, 0);
  });

  it("refuses an idempotency key the API would reject, before any request", async () => {
    const scripted = scriptedGateway([]);
    const adapter = createShotstackAdapter({ transport: scripted.gateway.transportFor("shotstack", ORG), connection: () => scripted.gateway.connection("shotstack", ORG) });
    await assert.rejects(
      adapter.submit({ idempotencyKey: "sha256 with a space", title: "t", body: expectedBody() }),
      (error) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(scripted.seen.length, 0);
  });

  it("fails closed when the integrity check does not pass: the render is not stored", async () => {
    const scripted = scriptedGateway([
      submitExchange({ body: expectedBody() }),
      pollExchange("done", { url: DOWNLOAD_URL }),
      downloadExchange(),
    ]);
    const { ledger, reservationId } = await reservedLedger();
    const deps = shotstackDepsFor(scripted.gateway, ledger, {
      verifyIntegrity: async (input): Promise<GateResult> => ({
        gate: "render_integrity",
        subjectId: input.videoId,
        pass: false,
        checks: [{ rule: "resolution_1080x1920", pass: false, detail: "1080x1080" }],
      }),
    });
    await assert.rejects(
      renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, deps),
      (error) => error instanceof EngineError && error.kind === "provider" && error.stage === "render_integrity",
    );
    assert.deepEqual(deps.stored, []);
  });

  it("refuses a component EDL before any request and writes no ledger entry", async () => {
    const scripted = scriptedGateway([]);
    const { ledger, reservationId } = await reservedLedger();
    await assert.rejects(
      renderEdlWithShotstack({ reservationId, edl: componentEdl, estimateUsd: 0.1, now: NOW }, shotstackDepsFor(scripted.gateway, ledger)),
      ShotstackRefusal,
    );
    assert.equal(scripted.seen.length, 0);
    assert.equal(await ledger.getEntryByKey(EXPECTED_KEY), null);
  });

  it("refuses a source URL that is not https before any request", async () => {
    const scripted = scriptedGateway([]);
    const { ledger, reservationId } = await reservedLedger();
    await assert.rejects(
      renderEdlWithShotstack(
        { reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW },
        shotstackDepsFor(scripted.gateway, ledger, { resolveSourceUrl: async (uri) => `http://plain.example.test/${uri}` }),
      ),
      (error) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(scripted.seen.length, 0);
  });

  it("is refused by the budget before any request, as HyperFrames is", async () => {
    const scripted = scriptedGateway([]);
    const { ledger, reservationId } = await reservedLedger(4);
    await assert.rejects(
      renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 50, now: NOW }, shotstackDepsFor(scripted.gateway, ledger)),
      (error) => error instanceof EngineError && error.kind === "conflict",
    );
    assert.equal(scripted.seen.length, 0);
  });

});
