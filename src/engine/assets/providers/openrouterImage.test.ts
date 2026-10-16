import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { classifyError, ProviderCallError } from "../classify.ts";
import { memoryMediaStore, type MediaStore } from "../adapter.ts";
import { assetSpec, base64, fixture, gatewayFor, json, pngBytes, scripted } from "../test/recorded.ts";
import { IMAGE_REFERENCES_MAX, openRouterImageAdapter } from "./openrouterImage.ts";

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

  it("sends exactly the request fields of the documented image shape, and each reference element is type plus image_url.url only", async () => {
    const recorded = fixture<{ request: { body_shape: Record<string, unknown> }; answer: unknown }>("openrouter-image-references.json");
    const { adapter, script } = setup({ [PATH]: json(200, recorded.answer) });
    await adapter.submit(
      assetSpec({
        modelClass: "image.edit",
        firstFrame: "https://media.example.test/engine/org_1/req_1/chain/frame-1.png",
        refs: ["https://media.example.test/engine/org_1/req_1/chain/hero.png"],
      }),
      "sha256:shape",
    );
    const sent = JSON.parse(String(script.requests[0]?.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(recorded.request.body_shape).sort(), "the body has the documented fields and no others");
    const [element] = sent.input_references as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(element ?? {}).sort(), ["image_url", "type"]);
    assert.deepEqual(Object.keys(element?.image_url as Record<string, unknown>), ["url"]);
    assert.equal(element?.type, "image_url");
  });

  it("sends the first frame and then the references as input references, in order, from the recorded answer", async () => {
    const recorded = fixture<{ answer: unknown }>("openrouter-image-references.json");
    const { adapter, script } = setup({ [PATH]: json(200, recorded.answer) });
    const spec = assetSpec({
      modelClass: "image.edit",
      firstFrame: "https://media.example.test/engine/org_1/req_1/chain/frame-1.png",
      refs: ["https://media.example.test/engine/org_1/req_1/chain/hero.png", "https://media.example.test/engine/org_1/req_1/chain/sheet.png"],
    });
    const { jobRef } = await adapter.submit(spec, "sha256:refs");
    const poll = await adapter.poll(jobRef);

    assert.equal(poll.state, "done");
    assert.equal(poll.actualUsd, 0.04);
    assert.equal(script.requests.length, 1, "one call, with the references in it");
    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.deepEqual(
      sent.input_references,
      [spec.firstFrame, ...spec.refs].map((url) => ({ type: "image_url", image_url: { url } })),
      "the first frame comes first, then the references, each as an image_url",
    );
    assert.equal(sent.seed, spec.seed);
  });

  it("sends no input_references when the spec has none, so a plain call is the same as before", async () => {
    const { adapter, script } = setup({ [PATH]: json(200, imageAnswer(pngBytes(), "image/png", 0.04)) });
    await adapter.submit(assetSpec({ modelClass: "image.keyframe" }), "k");
    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal("input_references" in sent, false);
  });

  it("refuses a reference that is not an https URL before any call, because the provider cannot read a store uri", async () => {
    const { adapter, script } = setup({});
    await assert.rejects(
      adapter.submit(assetSpec({ modelClass: "image.keyframe", refs: ["store://characters/fixture/sheet-1.png"] }), "k"),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /https/.test(error.message),
    );
    assert.equal(script.requests.length, 0);
  });

  it("refuses a last frame, and more references than the adapter takes, before any call", async () => {
    const { adapter, script } = setup({});
    const url = (name: string) => `https://media.example.test/${name}.png`;
    await assert.rejects(
      adapter.submit(assetSpec({ modelClass: "image.edit", lastFrame: url("last") }), "k"),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    const tooMany = [1, 2, 3, 4, 5].map((n) => url(`ref-${n}`));
    await assert.rejects(
      adapter.submit(assetSpec({ modelClass: "image.edit", refs: tooMany }), "k"),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /references/.test(error.message),
    );
    assert.equal(script.requests.length, 0);
  });

  it("carries the answer in the job reference, so a poll by another adapter instance (another worker) reads the same result", async () => {
    const media = memoryMediaStore();
    const first = setup({ [PATH]: json(200, imageAnswer(pngBytes(), "image/png", 0.04)) }, media).adapter;
    const { jobRef } = await first.submit(assetSpec({ modelClass: "image.keyframe" }), "sha256:worker");
    assert.ok(jobRef.length <= 512, "the reference fits the router's job reference limit");
    const second = setup({}, media).adapter;
    const poll = await second.poll(jobRef);
    assert.equal(poll.state, "done");
    assert.match(poll.uri ?? "", /^memory:\/\/org_1\//);
    assert.equal(poll.actualUsd, 0.04);
    assert.deepEqual(second.detailsFor(jobRef), { mediaType: "image/png" });
  });

  it("a reference this adapter did not write is a failed poll with no result, never a guess", async () => {
    const { adapter } = setup({});
    const poll = await adapter.poll("image:sha256:not-ours");
    assert.equal(poll.state, "failed");
    assert.equal(adapter.detailsFor("image:sha256:not-ours"), undefined);
  });

  it("declares first-frame and reference support, so the router sends a reference spec to the image route", () => {
    const { adapter } = setup({});
    assert.equal(adapter.capabilities.firstFrame, true);
    assert.equal(adapter.capabilities.lastFrame, false);
    assert.equal(adapter.capabilities.refsMax, IMAGE_REFERENCES_MAX);
    assert.deepEqual(adapter.capabilities.aspect, ["9:16"]);
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
