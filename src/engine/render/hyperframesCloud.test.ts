// HyperFrames cloud adapter (Bible 6.11): recorded responses, the idempotency key, the key handling, the budget
// hold and reconciliation, and the render-integrity check. The transport is scripted; no request leaves the test.
// The responses are constructed from the CLI 0.8.154 client (see recorded.ts), so these tests do not verify the live
// API. The owner's live run does (STATUS.md).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { EngineError, renderedVideoSchema, type GateResult } from "../contracts/index.ts";
import { edlFixture, FIXTURE_IDS, scenePlanFixture, styleKitFixture, WORKSPACE_ID } from "../contracts/fixtures/index.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { authorizeCall, reserve } from "../budget/reserve.ts";
import { compile } from "../compose/compiler.ts";
import {
  createHyperframesCloudAdapter,
  DIRECT_UPLOAD_LIMIT_BYTES,
  HYPERFRAMES_LEDGER_PROVIDER,
  renderComposition,
  type RenderAdapter,
  type RenderDeps,
  type RenderRequest,
  type RenderSubmitInput,
  type RenderTransport,
  type TransportRequest,
} from "./hyperframesCloud.ts";
import { buildZip } from "./zip.ts";
import {
  apiError,
  ASSET_ID,
  RENDER_ID,
  renderCreate,
  renderPoll,
  successfulRender,
  type ScriptedExchange,
  uploadComplete,
  uploadPut,
  uploadStart,
  VIDEO_BYTES,
  VIDEO_URL,
} from "./recorded.ts";

const FAKE_KEY = "test-key-not-a-real-credential";
const text = (value: string) => new TextEncoder().encode(value);
const noSleep = async () => undefined;

type Scripted = { transport: RenderTransport; seen: TransportRequest[] };

/** Wraps an adapter so the tests can count how many times a render is submitted to the provider. */
function countingAdapter(inner: RenderAdapter<RenderSubmitInput>): { adapter: RenderAdapter<RenderSubmitInput>; submits: () => number } {
  let count = 0;
  return {
    adapter: {
      renderer: inner.renderer,
      ready: () => inner.ready(),
      submit: async (input) => {
        count += 1;
        return inner.submit(input);
      },
      poll: (renderId) => inner.poll(renderId),
      fetchResult: (status) => inner.fetchResult(status),
    },
    submits: () => count,
  };
}

/** A transport that plays the exchanges in order and checks each request against them. */
function scripted(exchanges: ScriptedExchange[]): Scripted {
  const seen: TransportRequest[] = [];
  let index = 0;
  const transport: RenderTransport = async (request) => {
    seen.push(request);
    const expected = exchanges[index];
    index += 1;
    assert.ok(expected, `unexpected request ${request.method} ${request.url}`);
    assert.equal(request.method, expected.method, `method for ${request.url}`);
    if (expected.urlPrefix) {
      assert.ok(request.url.startsWith(expected.url), `url ${request.url} starts with ${expected.url}`);
    } else {
      assert.equal(request.url, expected.url);
    }
    for (const rule of expected.requireHeaders ?? []) {
      const absent = rule.startsWith("!");
      const name = absent ? rule.slice(1) : rule;
      const found = header(request, name);
      if (absent) {
        assert.equal(found, undefined, `${name} must not be sent to ${request.url}`);
      } else {
        assert.ok(found !== undefined, `${name} must be sent to ${request.url}`);
      }
    }
    for (const [name, value] of Object.entries(expected.expectHeaders ?? {})) {
      assert.equal(header(request, name), value, `${name} on ${request.url}`);
    }
    const body =
      expected.bytes ?? (expected.json !== undefined ? text(JSON.stringify(expected.json)) : new Uint8Array(0));
    return { status: expected.status, body };
  };
  return { transport, seen };
}

/** The JSON body of a request. The adapter sends JSON as a string. */
function jsonBody(request: TransportRequest): unknown {
  const body = request.body;
  assert.ok(typeof body === "string", "a JSON request sends a string body");
  return JSON.parse(body);
}

function header(request: TransportRequest, name: string): string | undefined {
  const key = Object.keys(request.headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : request.headers[key];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const compiled = compile(edlFixture, styleKitFixture);

async function reservedLedger(requestBudgetUsd = 4): Promise<{ ledger: LedgerStore; reservationId: string }> {
  const ledger = memoryLedgerStore();
  const result = await reserve(ledger, {
    requestId: FIXTURE_IDS.request,
    workspaceId: WORKSPACE_ID,
    mode: "cap",
    plan: scenePlanFixture,
    requestBudgetUsd,
    workspaceMonthBudgetUsd: 100,
    now: "2026-10-13T09:00:00.000Z",
    reservationId: FIXTURE_IDS.reservation,
  });
  return { ledger, reservationId: result.reservation.reservationId };
}

function passingGate(videoId: string): GateResult {
  return {
    gate: "render_integrity",
    subjectId: videoId,
    pass: true,
    checks: [
      { rule: "resolution_1080x1920", pass: true },
      { rule: "fps_30", pass: true },
      { rule: "duration_within_100ms", pass: true, value: 24000, limit: 24100 },
      { rule: "audio_present", pass: true },
    ],
  };
}

function renderRequest(reservationId: string, overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    requestId: FIXTURE_IDS.request,
    reservationId,
    composition: compiled.composition,
    files: compiled.files,
    assets: compiled.assets,
    durationMs: edlFixture.durationMs,
    estimateUsd: 0.05,
    now: "2026-10-13T09:05:00.000Z",
    title: "fixture",
    ...overrides,
  };
}

function deps(
  transport: RenderTransport,
  ledger: LedgerStore,
  overrides: Partial<RenderDeps> & { key?: string | null } = {},
): RenderDeps & { stored: string[] } {
  const stored: string[] = [];
  const { key, ...rest } = overrides;
  const credentialValue = key === undefined ? FAKE_KEY : key;
  const adapter = createHyperframesCloudAdapter({
    transport,
    credential: async () => credentialValue,
    sleep: noSleep,
  });
  return {
    adapter,
    ledger,
    resolveAsset: async (uri) => text(`bytes of ${uri}`),
    verifyIntegrity: async (input) => passingGate(input.videoId),
    storeVideo: async ({ videoId }) => {
      stored.push(videoId);
      return `store://renders/${videoId}.mp4`;
    },
    pollIntervalMs: 0,
    sleep: noSleep,
    newVideoId: () => FIXTURE_IDS.video,
    stored,
    ...rest,
  };
}

describe("HyperframesCloudAdapter.submit (recorded responses)", () => {
  it("uploads the archive, then creates the render with the composition hash as its Idempotency-Key", async () => {
    const archive = buildZip(compiled.files);
    const { transport, seen } = scripted([uploadStart(), uploadPut(), uploadComplete(), renderCreate()]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => FAKE_KEY, sleep: noSleep });
    const key = compiled.composition.contentHash;

    const submitted = await adapter.submit({ idempotencyKey: key, archive, title: "fixture" });

    assert.equal(submitted.renderId, RENDER_ID);
    assert.equal(submitted.status, "queued");
    assert.equal(header(seen[0], "Idempotency-Key"), `${key}:upload`, "the upload start has its own derived key");
    assert.deepEqual(jsonBody(seen[0]), {
      filename: "composition.zip",
      content_type: "application/zip",
      size_bytes: archive.byteLength,
      checksum_sha256: sha256Hex(archive),
    });
    assert.deepEqual(seen[1].body, archive, "the presigned PUT carries the archive bytes");
    assert.deepEqual(jsonBody(seen[2]), {
      checksum_sha256: sha256Hex(archive),
    });
    assert.equal(header(seen[3], "Idempotency-Key"), key, "the render key is exactly Composition.contentHash");
    const body = jsonBody(seen[3]) as { project: unknown; fps: number; format: string; aspect_ratio: string; resolution: string };
    assert.deepEqual(body.project, { type: "asset_id", asset_id: ASSET_ID });
    assert.equal(body.fps, 30);
    assert.equal(body.format, "mp4");
    assert.equal(body.aspect_ratio, "9:16");
    assert.equal(body.resolution, "1080p");
    assert.equal(header(seen[3], "X-HeyGen-Client-Source"), "hyperframes");
    assert.equal(seen.length, 4);
  });

  it("sends the key only to the API, never to the presigned upload", async () => {
    const { transport, seen } = scripted([uploadStart(), uploadPut(), uploadComplete(), renderCreate()]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => FAKE_KEY, sleep: noSleep });
    await adapter.submit({ idempotencyKey: compiled.composition.contentHash, archive: buildZip(compiled.files), title: "t" });
    assert.equal(header(seen[0], "x-api-key"), FAKE_KEY);
    assert.equal(header(seen[1], "x-api-key"), undefined);
    assert.ok(!JSON.stringify(seen.map((request) => request.headers)).includes("undefined"));
  });

  it("sends nothing and throws a config error when no key is available", async () => {
    const { transport, seen } = scripted([]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => null, sleep: noSleep });
    await assert.rejects(adapter.ready(), (error: unknown) => error instanceof EngineError && error.kind === "config");
    await assert.rejects(
      adapter.submit({ idempotencyKey: compiled.composition.contentHash, archive: buildZip(compiled.files), title: "t" }),
      (error: unknown) => error instanceof EngineError && error.kind === "config" && !/test-key/.test(error.message),
    );
    assert.equal(seen.length, 0);
  });

  it("refuses an idempotency key the API would reject, before sending anything", async () => {
    const { transport, seen } = scripted([]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => FAKE_KEY, sleep: noSleep });
    await assert.rejects(
      adapter.submit({ idempotencyKey: "sha256 with a space", archive: buildZip(compiled.files), title: "t" }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(seen.length, 0);
  });

  it("retries a 409 on upload completion with a linear backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { transport } = scripted([
      uploadStart(),
      uploadPut(),
      uploadComplete(409),
      uploadComplete(409),
      uploadComplete(200),
      renderCreate(),
    ]);
    const adapter = createHyperframesCloudAdapter({
      transport,
      credential: async () => FAKE_KEY,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const submitted = await adapter.submit({
      idempotencyKey: compiled.composition.contentHash,
      archive: buildZip(compiled.files),
      title: "t",
    });
    assert.equal(submitted.renderId, RENDER_ID);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it("maps a rate limit to a retryable error and an authentication failure to a non-retryable one", async () => {
    const limited = scripted([
      uploadStart(),
      uploadPut(),
      uploadComplete(),
      apiError("POST", "https://api.heygen.com/v3/hyperframes/renders", 429, "rate_limit_exceeded", "slow down"),
    ]);
    const adapter = createHyperframesCloudAdapter({ transport: limited.transport, credential: async () => FAKE_KEY, sleep: noSleep });
    await assert.rejects(
      adapter.submit({ idempotencyKey: compiled.composition.contentHash, archive: buildZip(compiled.files), title: "t" }),
      (error: unknown) =>
        error instanceof EngineError && error.kind === "provider" && error.retryable === true && /rate_limit_exceeded/.test(error.message),
    );

    const refused = scripted([apiError("POST", "https://api.heygen.com/v3/assets/direct-uploads", 401, "authentication_failed", "bad key")]);
    const denied = createHyperframesCloudAdapter({ transport: refused.transport, credential: async () => FAKE_KEY, sleep: noSleep });
    await assert.rejects(
      denied.submit({ idempotencyKey: compiled.composition.contentHash, archive: buildZip(compiled.files), title: "t" }),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.equal(error.retryable, false);
        assert.equal(/test-key/.test(error.message), false, "the key never appears in an error");
        return true;
      },
    );
  });
});

describe("HyperframesCloudAdapter.poll and fetchResult (recorded responses)", () => {
  it("reports a rendering status, then downloads the completed video without the key", async () => {
    const { transport, seen } = scripted([renderPoll("rendering"), renderPoll("completed", { video_url: VIDEO_URL }), {
      method: "GET",
      url: VIDEO_URL,
      status: 200,
      bytes: VIDEO_BYTES,
      requireHeaders: ["!x-api-key"],
    }]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => FAKE_KEY, sleep: noSleep });
    const first = await adapter.poll(RENDER_ID);
    assert.equal(first.status, "rendering");
    const done = await adapter.poll(RENDER_ID);
    assert.equal(done.videoUrl, VIDEO_URL);
    const fetched = await adapter.fetchResult(done);
    assert.deepEqual(fetched.bytes, VIDEO_BYTES);
    assert.equal(seen.length, 3);
  });

  it("refuses to download a render that has not completed", async () => {
    const { transport } = scripted([]);
    const adapter = createHyperframesCloudAdapter({ transport, credential: async () => FAKE_KEY, sleep: noSleep });
    await assert.rejects(adapter.fetchResult({ renderId: RENDER_ID, status: "rendering" }), (error: unknown) => error instanceof EngineError);
  });
});

describe("renderComposition: budget, idempotency, integrity", () => {
  it("renders a composition end to end: one ledger entry keyed by the hash, a valid RenderedVideo, the stored video", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const { transport, seen } = scripted(successfulRender());
    let integrityInput: { width: number; height: number; fps: number; durationMs: number; bytes: Uint8Array } | undefined;
    const runDeps = deps(transport, ledger, {
      verifyIntegrity: async (input) => {
        integrityInput = { width: input.width, height: input.height, fps: input.fps, durationMs: input.durationMs, bytes: input.bytes };
        return passingGate(input.videoId);
      },
    });

    const outcome = await renderComposition(renderRequest(reservationId), runDeps);

    const video = renderedVideoSchema.parse(outcome.video);
    assert.equal(video.idempotencyKey, compiled.composition.contentHash);
    assert.equal(video.renderer, "hyperframes-cloud");
    assert.equal(video.costUsd, null, "no bill came back, so no cost is booked (contract v6)");
    assert.equal(video.bytes, VIDEO_BYTES.byteLength);
    assert.equal(video.uri, `store://renders/${FIXTURE_IDS.video}.mp4`);

    assert.deepEqual(integrityInput, {
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: edlFixture.durationMs,
      bytes: VIDEO_BYTES,
    });
    assert.ok(Buffer.from(seen[1].body as Uint8Array).includes(Buffer.from("index.html")), "the archive holds the composition");
    assert.ok(Buffer.from(seen[1].body as Uint8Array).includes(Buffer.from("assets/")), "the archive holds the assets");

    const entries = await ledger.listEntries(reservationId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].stage, "render");
    assert.equal(entries[0].provider, HYPERFRAMES_LEDGER_PROVIDER);
    assert.equal(entries[0].idempotencyKey, compiled.composition.contentHash);
    assert.equal(entries[0].reservedUsd, 0.05);
    assert.equal(entries[0].actualUsd, undefined, "no provider bill is known: the actual stays unset, never the estimate");
    assert.equal(entries[0].settlement, undefined);
    assert.equal((await ledger.getReservation(reservationId))?.state, "reserved");
  });

  it("a successful render with no bill has costUsd null, and estimateUsd equal to the render line (contract v6)", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const { transport } = scripted(successfulRender());
    const outcome = await renderComposition(renderRequest(reservationId, { estimateUsd: 0.05 }), deps(transport, ledger));
    assert.equal(outcome.video.costUsd, null);
    assert.equal(outcome.video.estimateUsd, 0.05);
    const [entry] = await ledger.listEntries(reservationId);
    assert.equal(entry?.reservedUsd, 0.05, "the render line is held");
    assert.equal(entry?.settlement, undefined, "the render stays unsettled until a bill or a confirmation");
  });

  it("a second render under the same key, while the first is unsettled, throws conflict and makes no second submit (contract v6)", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const first = scripted(successfulRender());
    const spy = countingAdapter(createHyperframesCloudAdapter({ transport: first.transport, credential: async () => FAKE_KEY, sleep: noSleep }));
    await renderComposition(renderRequest(reservationId), { ...deps(first.transport, ledger), adapter: spy.adapter });
    assert.equal(spy.submits(), 1);

    const second = scripted([]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), { ...deps(second.transport, ledger), adapter: spy.adapter }),
      (error: unknown) =>
        error instanceof EngineError &&
        error.kind === "conflict" &&
        error.retryable === false &&
        /not submitted again/.test(error.message),
    );
    assert.equal(spy.submits(), 1, "the adapter is not asked to submit the same key again");
    assert.equal(second.seen.length, 0, "no request reaches the provider");
    assert.equal((await ledger.listEntries(reservationId)).length, 1, "the ledger keeps one entry for the key");
  });

  it("makes no request and writes no entry when the budget line refuses the render", async () => {
    const { ledger, reservationId } = await reservedLedger(0.001);
    // A paid call committed past the 0.001 USD line: the render starts at the line, so the budget refuses it (D12).
    const earlier = await authorizeCall(ledger, {
      reservationId,
      stage: "produce_shot",
      provider: "openrouter",
      model: "fixture-model",
      estimateUsd: 0.002,
      idempotencyKey: "earlier-call-past-the-line",
      at: "2026-10-13T09:00:30.000Z",
    });
    assert.equal(earlier.status, "authorized", "the earlier call started below the line");
    const { transport, seen } = scripted([]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), deps(transport, ledger)),
      (error: unknown) => error instanceof EngineError && error.kind === "conflict" && /refused by the budget/.test(error.message),
    );
    assert.equal(seen.length, 0);
    assert.equal((await ledger.listEntries(reservationId)).length, 1, "only the earlier call is recorded");
  });

  it("makes no request and writes no entry when no key is available", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const { transport, seen } = scripted([]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), deps(transport, ledger, { key: null })),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.equal(seen.length, 0);
    assert.equal((await ledger.listEntries(reservationId)).length, 0, "no hold is taken for a call that cannot be made");
  });

  it("does not re-submit a failed render under its key: the failure is non-retryable, is not reconciled, and keeps one ledger entry (contract v6)", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const failing = scripted([
      uploadStart(),
      uploadPut(),
      uploadComplete(),
      renderCreate(),
      renderPoll("failed", { failure_message: "composition could not load its audio" }),
    ]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), deps(failing.transport, ledger)),
      (error: unknown) =>
        error instanceof EngineError &&
        error.kind === "provider" &&
        error.retryable === false &&
        /composition could not load its audio/.test(error.message) &&
        /cost is unsettled/.test(error.message),
    );
    const afterFailure = await ledger.listEntries(reservationId);
    assert.equal(afterFailure.length, 1);
    assert.equal(afterFailure[0].actualUsd, undefined, "a failed render is not reconciled: no cost is booked");
    assert.equal(afterFailure[0].settlement, undefined, "the held amount stays unsettled");

    const retry = scripted([]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), deps(retry.transport, ledger)),
      (error: unknown) =>
        error instanceof EngineError && error.kind === "conflict" && error.retryable === false && /not submitted again/.test(error.message),
    );
    assert.equal(retry.seen.length, 0, "no request reaches the provider under the same key");
    assert.equal((await ledger.listEntries(reservationId)).length, 1, "the ledger never bills the same key twice");
  });

  it("fails closed when the render-integrity check does not pass, and stores nothing", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const { transport } = scripted(successfulRender());
    let stored = false;
    await assert.rejects(
      renderComposition(
        renderRequest(reservationId),
        deps(transport, ledger, {
          verifyIntegrity: async (input) => ({
            gate: "render_integrity",
            subjectId: input.videoId,
            pass: false,
            checks: [
              { rule: "resolution_1080x1920", pass: true },
              { rule: "duration_within_100ms", pass: false, value: 23000, limit: 24100 },
            ],
          }),
          storeVideo: async () => {
            stored = true;
            return "store://never";
          },
        }),
      ),
      (error: unknown) =>
        error instanceof EngineError &&
        error.kind === "provider" &&
        error.retryable === false &&
        error.stage === "render_integrity" &&
        /duration_within_100ms/.test(error.message),
    );
    assert.equal(stored, false);
  });

  it("refuses a composition whose files do not match its hash, before sending or holding anything", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const tampered = compiled.files.map((file) =>
      file.path === "index.html" ? { path: file.path, bytes: text("<html>changed</html>") } : file,
    );
    const { transport, seen } = scripted([]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId, { files: tampered }), deps(transport, ledger)),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /does not match its hash/.test(error.message),
    );
    assert.equal(seen.length, 0);
    assert.equal((await ledger.listEntries(reservationId)).length, 0);
  });

  it("is a retryable timeout when the render never finishes, and keeps the hold for a resume", async () => {
    const { ledger, reservationId } = await reservedLedger();
    const { transport } = scripted([
      uploadStart(),
      uploadPut(),
      uploadComplete(),
      renderCreate(),
      renderPoll("rendering"),
      renderPoll("rendering"),
    ]);
    await assert.rejects(
      renderComposition(renderRequest(reservationId), deps(transport, ledger, { maxPolls: 2 })),
      (error: unknown) => error instanceof EngineError && error.retryable === true && /did not finish after 2 polls/.test(error.message),
    );
    const entries = await ledger.listEntries(reservationId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actualUsd, undefined, "the hold stays until the render is resolved");
  });

  it("names the limit in a constant the owner can read", () => {
    assert.equal(DIRECT_UPLOAD_LIMIT_BYTES, 200 * 1024 * 1024);
  });
});
