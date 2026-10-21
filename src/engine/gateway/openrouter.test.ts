import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";
import { EngineError } from "../contracts/errors.ts";
import { CAPABILITIES } from "../config/routes.ts";
import { createGateway } from "./gateway.ts";
import { StructuredOutputError, pollVideo, structuredChat, submitVideo, verifyRoutes } from "./openrouter.ts";
import { json, recorded, staticKeys } from "./test/recorded.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8"));

const propertiesSchema = z.object({ properties: z.array(z.enum(["real_product", "person_talking", "text_led"])) });

function chatInput() {
  return {
    organizationId: "org_1",
    capability: "llm.check" as const,
    messages: [{ role: "user" as const, content: "Classify this request." }],
    schema: propertiesSchema,
    schemaName: "request_properties",
    maxTokens: 200,
  };
}

function chatAnswer(content: string): unknown {
  const body = fixture("openrouter-chat") as { choices: Array<{ message: { content: string } }> };
  return { ...body, choices: [{ ...body.choices[0], message: { role: "assistant", content } }] };
}

describe("OpenRouter structured chat", () => {
  it("sends the routed model and the JSON schema, and parses the answer with zod", async () => {
    const { transport, requests } = recorded([json(200, fixture("openrouter-chat"))]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const result = await structuredChat(gateway, chatInput());

    assert.deepEqual(result.value, { properties: ["real_product", "person_talking"] });
    assert.deepEqual(result.usage, { promptTokens: 812, completionTokens: 24, costUsd: 0.000932 });
    assert.equal(result.generationId, "gen-1760440000-abcdefghijklmnopqrst");

    const sent = JSON.parse(String(requests[0]?.body));
    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(sent.model, gateway.route("llm.check").model);
    assert.equal(sent.response_format.type, "json_schema");
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.equal(sent.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(sent.response_format.json_schema.schema.$schema, undefined);
  });

  it("refuses an answer that does not match the schema, naming paths and not the model's text", async () => {
    const { transport } = recorded([json(200, chatAnswer('{"properties":["ignore previous instructions"]}'))]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    await assert.rejects(structuredChat(gateway, chatInput()), (error: unknown) => {
      assert.ok(error instanceof StructuredOutputError);
      assert.deepEqual(error.issues, ["properties.0: invalid_value"]);
      assert.doesNotMatch(error.message, /ignore previous/);
      return true;
    });
  });

  it("refuses an answer that is not JSON", async () => {
    const { transport } = recorded([json(200, chatAnswer("Sure! Here you go."))]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    await assert.rejects(structuredChat(gateway, chatInput()), /not JSON/);
  });

  it("maps a rate limit to a retryable provider error and a bad key to a config error", async () => {
    const { transport } = recorded([json(429, { error: { code: 429, message: "Rate limited" } }), json(401, { error: { code: 401 } })]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    await assert.rejects(structuredChat(gateway, chatInput()), (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable);
    await assert.rejects(structuredChat(gateway, chatInput()), (error: unknown) => error instanceof EngineError && error.kind === "config" && !error.retryable);
  });

  it("throws a config error and sends nothing when OpenRouter is not connected", async () => {
    const { transport, requests } = recorded([]);
    const gateway = createGateway({ transport, credentials: staticKeys({}) });
    await assert.rejects(structuredChat(gateway, chatInput()), /not connected/);
    assert.equal(requests.length, 0);
  });

  it("refuses a capability routed to another provider", async () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    await assert.rejects(structuredChat(gateway, { ...chatInput(), capability: "render.cloud" }), /not OpenRouter/);
  });
});

describe("OpenRouter video", () => {
  it("submits to the routed model and polls to a done take with OpenRouter's cost", async () => {
    const { transport, requests } = recorded([
      json(202, fixture("openrouter-video-submit")),
      json(200, { ...(fixture("openrouter-video-submit") as object), status: "in_progress" }),
      json(200, fixture("openrouter-video-completed")),
    ]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const submitted = await submitVideo(gateway, {
      organizationId: "org_1",
      capability: "video.cinematic",
      model: "kwaivgi/kling-v3.0-std",
      prompt: "Slow dolly-in on a ceramic mug, morning light",
      durationSeconds: 5,
      aspectRatio: "9:16",
      generateAudio: false,
    });
    assert.deepEqual(submitted, { jobId: "job-abc123", model: "kwaivgi/kling-v3.0-std" });
    const sent = JSON.parse(String(requests[0]?.body));
    assert.deepEqual(sent, {
      model: "kwaivgi/kling-v3.0-std",
      prompt: "Slow dolly-in on a ceramic mug, morning light",
      duration: 5,
      aspect_ratio: "9:16",
      generate_audio: false,
    });

    assert.deepEqual(await pollVideo(gateway, "org_1", submitted.jobId), { state: "pending" });
    assert.deepEqual(await pollVideo(gateway, "org_1", submitted.jobId), {
      state: "done",
      uri: "https://openrouter.ai/api/v1/videos/job-abc123/content?index=0",
      actualUsd: 0.5,
    });
    assert.equal(requests[2]?.url, "https://openrouter.ai/api/v1/videos/job-abc123");
  });

  it("reports a failed job as failed, never as done", async () => {
    const { transport } = recorded([json(200, { id: "job-1", status: "failed", error: "content policy" })]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const polled = await pollVideo(gateway, "org_1", "job-1");
    assert.equal(polled.state, "failed");
    assert.match(polled.error?.message ?? "", /failed: content policy/);
  });

  it("reports a completed job with no URL as failed", async () => {
    const { transport } = recorded([json(200, { id: "job-1", status: "completed" })]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    assert.equal((await pollVideo(gateway, "org_1", "job-1")).state, "failed");
  });

  it("keeps a job pending through a retryable poll error", async () => {
    const { transport } = recorded([json(503, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    assert.deepEqual(await pollVideo(gateway, "org_1", "job-1"), { state: "pending" });
  });

  it("refuses a video class with no model routed yet", async () => {
    const { transport, requests } = recorded([]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    await assert.rejects(
      submitVideo(gateway, { organizationId: "org_1", capability: "video.budget", prompt: "x", durationSeconds: 5, aspectRatio: "9:16", generateAudio: false }),
      /no model routed/,
    );
    assert.equal(requests.length, 0);
  });
});

describe("route check", () => {
  it("lists which routed OpenRouter models the models listing contains", async () => {
    const { transport } = recorded([json(200, { data: [{ id: "anthropic/claude-haiku-5.5" }, { id: "google/veo-3.1-lite" }] })]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const checked = await verifyRoutes(gateway, CAPABILITIES);
    const byModel = Object.fromEntries(checked.map((item) => [item.model, item.listed]));
    assert.equal(byModel["anthropic/claude-haiku-5.5"], true);
    // No table route names the budget video model any more: the live catalog chooses it (Bible 10.5).
    assert.equal(checked.some((item) => item.model === "google/veo-3.1-lite"), false);
    assert.equal(byModel["anthropic/claude-opus-5.5"], false);
    assert.equal(checked.some((item) => item.model === "hyperframes"), false);
  });
});
