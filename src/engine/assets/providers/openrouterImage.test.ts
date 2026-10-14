import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { classifyError, ProviderCallError } from "../classify.ts";
import { memoryMediaStore, type MediaStore } from "../adapter.ts";
import { assetSpec, base64, gatewayFor, json, pngBytes, scripted } from "../test/recorded.ts";
import { openRouterImageAdapter } from "./openrouterImage.ts";

const PATH = "POST /api/v1/images";

function imageAnswer(bytes: Uint8Array, mediaType: string, cost: number | undefined) {
  return {
    created: 1748372400,
    data: [{ b64_json: base64(bytes), media_type: mediaType }],
    usage: cost === undefined ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost },
  };
}

function setup(replies: Parameters<typeof scripted>[0], media: MediaStore = memoryMediaStore()) {
  const script = scripted(replies);
  const gateway = gatewayFor(script.transport);
  const route = gateway.routes("image.keyframe")[0];
  if (!route) throw new Error("no image route");
  const adapter = openRouterImageAdapter({ gateway, organizationId: "org_1", workspaceId: "org_1", route, media });
  return { adapter, script, media };
}

describe("OpenRouter image", () => {
  it("decodes the bytes, stores them, and returns the bill from usage.cost", async () => {
    const media = memoryMediaStore();
    const { adapter, script } = setup({ [PATH]: json(200, imageAnswer(pngBytes(), "image/png", 0.04)) }, media);
    const spec = assetSpec({ modelClass: "image.keyframe", durationMs: 1000 });
    const { jobRef } = await adapter.submit(spec, "sha256:key");
    const poll = await adapter.poll(jobRef);

    assert.equal(poll.state, "done");
    assert.match(poll.uri ?? "", /^memory:\/\/org_1\//);
    assert.equal(poll.actualUsd, 0.04);
    assert.equal(media.objects.size, 1);
    assert.equal([...media.objects.values()][0]?.mediaType, "image/png");
    assert.deepEqual(adapter.detailsFor(jobRef), { mediaType: "image/png" });

    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/images");
    assert.equal(sent.model, "bytedance-seed/seedream-4.5");
    assert.equal(sent.n, 1);
    assert.equal(sent.aspect_ratio, "9:16");
    assert.equal(sent.output_format, "png");
    assert.equal(sent.seed, spec.seed);
  });

  it("prices one image from the table", () => {
    const { adapter } = setup({});
    assert.equal(adapter.price(assetSpec({ modelClass: "image.keyframe" })).estimateUsd, 0.04);
  });

  it("refuses references and frames before any call", async () => {
    const { adapter, script } = setup({});
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "image.keyframe", refs: ["https://a.example.com/x.png"] }), "k"), EngineError);
    assert.equal(script.requests.length, 0);
  });

  it("keeps the bill when the image is refused for its type, so the ledger is not under-counted", async () => {
    const { adapter } = setup({ [PATH]: json(200, imageAnswer(pngBytes(), "image/svg+xml", 0.04)) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "image.keyframe" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.equal(poll.error?.kind, "unknown");
    assert.equal(poll.actualUsd, 0.04);
  });

  it("keeps the bill when the base64 is not canonical", async () => {
    const body = { data: [{ b64_json: "not base64!", media_type: "image/png" }], usage: { cost: 0.04 } };
    const { adapter } = setup({ [PATH]: json(200, body) });
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "image.keyframe" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.equal(poll.actualUsd, 0.04);
  });

  it("keeps the bill when storage fails after a paid answer", async () => {
    const failing: MediaStore = {
      put: async () => {
        throw new Error("object store unavailable");
      },
    };
    const { adapter } = setup({ [PATH]: json(200, imageAnswer(pngBytes(), "image/png", 0.04)) }, failing);
    const { jobRef } = await adapter.submit(assetSpec({ modelClass: "image.keyframe" }), "k");
    const poll = await adapter.poll(jobRef);
    assert.equal(poll.state, "failed");
    assert.equal(poll.actualUsd, 0.04);
    assert.match(poll.error?.message ?? "", /could not be stored/);
  });

  it("a rate limit on the call is classified and throws before any poll", async () => {
    const { adapter } = setup({ [PATH]: json(429, { error: "rate limited" }) });
    await assert.rejects(adapter.submit(assetSpec({ modelClass: "image.keyframe" }), "k"), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(classifyError(error).kind, "rate_limit");
      return true;
    });
  });
});
