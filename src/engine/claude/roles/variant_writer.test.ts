import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RoleAnswerError } from "../errors.ts";
import { runRole } from "../client.ts";
import { estimateClaudeUsd } from "../rates.ts";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { routes } from "../../config/routes.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { deps, gatewayFor, json, ledgerWith, request, sentMessages, textOf } from "../test/helpers.ts";
import {
  VARIANT_WRITER_ESTIMATE_TOKENS,
  VARIANT_WRITER_MAX_OUTPUT_TOKENS,
  VARIANT_WRITER_PROMPT,
  variantWriter,
  variantWriterAnswerSchema,
  variantWriterInputSchema,
  variantWriterUserContent,
  type VariantWriterInput,
  type VariantWriterLinesInput,
  type VariantWriterProductInput,
} from "./variant_writer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "..", "..", "prompts");

/** The model the check route is routed to (config/routes.ts). The test reads it, so the test names no model. */
const CHECK_MODEL = routes.table["llm.check"].targets[0]?.model ?? "";

function languageInput(overrides: Partial<VariantWriterLinesInput> = {}): VariantWriterInput {
  return variantWriterInputSchema.parse({
    task: "lines",
    variant: { attribute: "language", label: "language de" },
    targetLanguage: "de",
    beats: [
      { beatId: "b1", role: "hook", text: "Your kitchen counter is lying to you.", emphasis: ["lying"] },
      { beatId: "b4", role: "proof", text: "It makes 4 smoothies in under 2 minutes.", emphasis: [] },
    ],
    claims: ["Makes four smoothies in under two minutes"],
    ...overrides,
  });
}

function hookInput(): VariantWriterInput {
  return variantWriterInputSchema.parse({
    task: "lines",
    variant: { attribute: "hook", label: "hook line 2 of 3" },
    targetLanguage: "en",
    beats: [{ beatId: "b1", role: "hook", text: "Your kitchen counter is lying to you.", emphasis: ["lying"] }],
    claims: [],
  });
}

function productInput(overrides: Partial<VariantWriterProductInput> = {}): VariantWriterInput {
  return variantWriterInputSchema.parse({
    task: "product_prompts",
    variant: { attribute: "product", label: "product SKU-2" },
    product: { name: "Corner Toaster", masterName: "Fixture Blender" },
    shots: [
      { shotId: "shot_a", prompt: "Slow push-in on a clean kitchen counter, the blender in the centre, soft window light, no text in frame." },
      { shotId: "shot_b", prompt: "Close angle on the blender base, steam rising, warm light, no text in frame." },
    ],
    ...overrides,
  });
}

function linesOf(input: VariantWriterInput): VariantWriterLinesInput {
  if (input.task !== "lines") throw new Error("the input is not a lines input");
  return input;
}

function parseAnswer(input: VariantWriterInput, value: unknown) {
  return variantWriterAnswerSchema(input).safeParse(value);
}

describe("the variant_writer input contract (Bible 6.13, 11.1)", () => {
  it("accepts a hook for one beat and a language for every beat", () => {
    assert.equal(linesOf(hookInput()).beats.length, 1);
    assert.equal(linesOf(languageInput()).beats.length, 2);
  });

  it("refuses a beat id used twice, no beats, and more beats than the limit", () => {
    const beat = { beatId: "b1", role: "hook", text: "Hello there.", emphasis: [] };
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: [beat, beat] }).success, false);
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: [] }).success, false);
    const many = Array.from({ length: 13 }, (_, index) => ({ beatId: `b${index}`, role: "setup", text: "Hello there.", emphasis: [] }));
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: many }).success, false);
  });

  it("refuses a lines attribute other than hook or language, and a task it does not know", () => {
    const bad = { ...languageInput(), variant: { attribute: "caption", label: "captions upper" } };
    assert.equal(variantWriterInputSchema.safeParse(bad).success, false);
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), task: "caption" }).success, false);
  });

  it("accepts a product input with its variant's product, the master's, and the shots to rewrite", () => {
    const input = productInput();
    assert.equal(input.task, "product_prompts");
    assert.equal(variantWriterInputSchema.safeParse(productInput({ product: { name: "Corner Toaster", masterName: null } })).success, true);
  });

  it("refuses a product input with a shot twice, no shot, or more shots than the limit", () => {
    const shot = { shotId: "shot_a", prompt: "A slow push-in." };
    assert.equal(variantWriterInputSchema.safeParse({ ...productInput(), shots: [shot, shot] }).success, false);
    assert.equal(variantWriterInputSchema.safeParse({ ...productInput(), shots: [] }).success, false);
    const many = Array.from({ length: 7 }, (_, index) => ({ shotId: `shot_${index}`, prompt: "A slow push-in." }));
    assert.equal(variantWriterInputSchema.safeParse({ ...productInput(), shots: many }).success, false);
  });
});

describe("the variant_writer answer contract", () => {
  it("accepts one line for each beat to write", () => {
    const result = parseAnswer(languageInput(), {
      lines: [
        { beatId: "b1", text: "Deine Arbeitsplatte belügt dich." },
        { beatId: "b4", text: "Er macht 4 Smoothies in unter 2 Minuten." },
      ],
    });
    assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
  });

  it("refuses a line for a beat that is not one of the beats to write", () => {
    const result = parseAnswer(hookInput(), { lines: [{ beatId: "b9", text: "A new opening." }] });
    assert.equal(result.success, false);
    assert.match(result.error?.issues[0]?.message ?? "", /not one of the beats to write/);
  });

  it("refuses a beat with two lines, and a beat with no line", () => {
    const twice = parseAnswer(languageInput(), {
      lines: [
        { beatId: "b1", text: "Eins." },
        { beatId: "b1", text: "Zwei." },
      ],
    });
    assert.equal(twice.success, false);
    assert.ok(twice.error?.issues.some((issue) => /two lines/.test(issue.message)));

    const missing = parseAnswer(languageInput(), { lines: [{ beatId: "b1", text: "Eins." }] });
    assert.equal(missing.success, false);
    assert.ok(missing.error?.issues.some((issue) => /beat b4 has no line/.test(issue.message)));
  });

  it("refuses a line that drops a number of its beat, and names the number", () => {
    const result = parseAnswer(languageInput(), {
      lines: [
        { beatId: "b1", text: "Deine Arbeitsplatte belügt dich." },
        { beatId: "b4", text: "Er macht vier Smoothies in kurzer Zeit." },
      ],
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.issues.some((issue) => issue.message === "the number 2 of the beat must be kept"));
  });

  it("does not take a number inside a longer number as the number kept", () => {
    const input = variantWriterInputSchema.parse({
      task: "lines",
      variant: { attribute: "language", label: "language de" },
      targetLanguage: "de",
      beats: [{ beatId: "b1", role: "proof", text: "It costs 29 dollars.", emphasis: [] }],
      claims: [],
    });
    assert.equal(parseAnswer(input, { lines: [{ beatId: "b1", text: "Es kostet 129 Dollar." }] }).success, false);
    assert.equal(parseAnswer(input, { lines: [{ beatId: "b1", text: "Es kostet 29 Dollar." }] }).success, true);
  });

  it("refuses an empty line and a line longer than 300 characters", () => {
    assert.equal(parseAnswer(hookInput(), { lines: [{ beatId: "b1", text: "" }] }).success, false);
    assert.equal(parseAnswer(hookInput(), { lines: [{ beatId: "b1", text: "x".repeat(301) }] }).success, false);
  });

  it("sends the answer schema as a JSON schema with the lines key", () => {
    const schema = JSON.stringify(jsonSchemaFor(variantWriterAnswerSchema(languageInput())));
    assert.match(schema, /"lines"/);
    assert.match(schema, /"beatId"/);
  });

  it("accepts one prompt for each shot, naming the variant's product and not the master's", () => {
    const result = parseAnswer(productInput(), {
      prompts: [
        { shotId: "shot_a", text: "Slow push-in on a clean kitchen counter, the Corner Toaster in the centre, soft window light, no text in frame." },
        { shotId: "shot_b", text: "Close angle on the Corner Toaster, a light crust forming, warm light, no text in frame." },
      ],
    });
    assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
  });

  it("refuses a prompt that keeps the master's product, one that names no product, and one that asks for quoted text", () => {
    const keepsMaster = parseAnswer(productInput(), {
      prompts: [
        { shotId: "shot_a", text: "The Corner Toaster beside the Fixture Blender, soft light." },
        { shotId: "shot_b", text: "The Corner Toaster, warm light." },
      ],
    });
    assert.equal(keepsMaster.success, false);
    assert.ok(keepsMaster.error?.issues.some((issue) => /must not keep the master's product name/.test(issue.message)));

    const namesNone = parseAnswer(productInput(), {
      prompts: [
        { shotId: "shot_a", text: "A bowl on a counter, soft light." },
        { shotId: "shot_b", text: "The Corner Toaster, warm light." },
      ],
    });
    assert.equal(namesNone.success, false);
    assert.ok(namesNone.error?.issues.some((issue) => /must name the variant's product/.test(issue.message)));

    const quoted = parseAnswer(productInput(), {
      prompts: [
        { shotId: "shot_a", text: 'The Corner Toaster with the word "fresh" on it.' },
        { shotId: "shot_b", text: "The Corner Toaster, warm light." },
      ],
    });
    assert.equal(quoted.success, false);
    assert.ok(quoted.error?.issues.some((issue) => /quoted text/.test(issue.message)));
  });

  it("refuses a prompt for a shot that is not in the block, and a shot with no prompt", () => {
    const unknown = parseAnswer(productInput(), { prompts: [{ shotId: "shot_z", text: "The Corner Toaster." }] });
    assert.equal(unknown.success, false);
    assert.ok(unknown.error?.issues.some((issue) => /not one of the shots to write/.test(issue.message)));

    const missing = parseAnswer(productInput(), { prompts: [{ shotId: "shot_a", text: "The Corner Toaster, soft light." }] });
    assert.equal(missing.success, false);
    assert.ok(missing.error?.issues.some((issue) => /shot shot_b has no prompt/.test(issue.message)));
  });
});

describe("the variant_writer role (Bible 11.1)", () => {
  it("is a check call on variant_writer@2, for the variants stage", () => {
    assert.equal(variantWriter.role, "variant_writer");
    assert.equal(variantWriter.capability, "llm.check");
    assert.equal(variantWriter.stage, "variants");
    assert.deepEqual(VARIANT_WRITER_PROMPT, { role: "variant_writer", version: 2 });
  });

  it("prices one call at Bible 11.1's 2k in and 0.5k out, under one cent", () => {
    assert.deepEqual(VARIANT_WRITER_ESTIMATE_TOKENS, { input: 2000, output: 500 });
    const usd = estimateClaudeUsd(CHECK_MODEL, variantWriter.estimateTokens);
    assert.equal(usd, 0.0045);
    assert.ok(usd < 0.01);
    assert.equal(variantWriter.maxOutputTokens, VARIANT_WRITER_MAX_OUTPUT_TOKENS);
  });

  it("sends the beats as one untrusted data block, with the variant and the language", () => {
    const text = variantWriterUserContent(languageInput()).map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.match(text, /<untrusted-data name="beats">/);
    assert.match(text, /"targetLanguage":"de"/);
    assert.match(text, /"attribute":"language"/);
  });

  it("sends the product shots as one untrusted data block, with the variant's product and the master's", () => {
    const text = variantWriterUserContent(productInput()).map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.match(text, /<untrusted-data name="shots">/);
    assert.match(text, /"name":"Corner Toaster"/);
    assert.match(text, /"masterName":"Fixture Blender"/);
  });

  it("pins the bytes of variant_writer@1 and @2 (a shipped version never changes)", () => {
    for (const [file, expected] of [
      ["variant_writer@1.md", "sha256:4c2aac567b21387d7e31cb972fdc59dc998f3c9b154c99f9af531a2256f891de"],
      ["variant_writer@2.md", "sha256:8a61f29242ff6f546ee1d8e078a818536a70f292fe4cd167ea8bf550ee2421f0"],
    ] as const) {
      const hash = `sha256:${createHash("sha256").update(readFileSync(join(PROMPTS, file))).digest("hex")}`;
      assert.equal(hash, expected, `${file} changed: ship a new version instead`);
    }
    assert.equal(loadPrompt(variantWriter.prompt).fileHash, "sha256:8a61f29242ff6f546ee1d8e078a818536a70f292fe4cd167ea8bf550ee2421f0");
  });

  it("runs through the Claude client on the request's reservation, and writes the role and version to the ledger", async () => {
    const ledger = await ledgerWith(0.05);
    const body = {
      id: "gen-variant-writer-1",
      model: CHECK_MODEL,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({ lines: [{ beatId: "b1", text: "Deine Arbeitsplatte belügt dich." }] }),
          },
        },
      ],
      usage: { prompt_tokens: 1900, completion_tokens: 60, total_tokens: 1960, cost: 0.0019 },
    };
    const { gateway, requests } = gatewayFor([json(200, body)]);
    const hook = languageInput({ beats: [{ beatId: "b1", role: "hook", text: "Your kitchen counter is lying to you.", emphasis: [] }] });
    const outcome = await runRole(deps(gateway, ledger), variantWriter, request(hook));

    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.ok("lines" in outcome.value, "the answer is lines");
    assert.equal(outcome.value.lines[0]?.text, "Deine Arbeitsplatte belügt dich.");
    assert.equal(outcome.calls.length, 1);
    assert.equal(outcome.calls[0]?.promptVersion, "variant_writer@2");
    assert.equal(outcome.calls[0]?.costUsd, 0.0019);
    assert.equal(outcome.calls[0]?.actualIsEstimate, false);

    const sent = JSON.parse(String(requests[0]?.body)) as { model: string; max_tokens: number; response_format: { json_schema: { name: string } } };
    assert.equal(sent.model, CHECK_MODEL);
    assert.equal(sent.max_tokens, VARIANT_WRITER_MAX_OUTPUT_TOKENS);
    assert.equal(sent.response_format.json_schema.name, "variant_writer_answer");
    assert.match(textOf(sentMessages(requests[0]?.body)[0]?.content), /^# variant_writer@2/);

    const rows = await ledger.listEntries("res_01JABCDEFGHJKMNPQRSTVWXYZ0");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, "variant_writer");
    assert.equal(rows[0]?.promptVersion, "variant_writer@2");
    assert.equal(rows[0]?.actualUsd, 0.0019);
  });

  it("retries once when the first answer drops a beat, and the retry answers", async () => {
    const ledger = await ledgerWith(0.05);
    const twoBeats = languageInput();
    const incomplete = { id: "gen-1", model: CHECK_MODEL, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ lines: [{ beatId: "b1", text: "Eins." }] }) } }], usage: { prompt_tokens: 1900, completion_tokens: 20, total_tokens: 1920, cost: 0.002 } };
    const complete = {
      id: "gen-2",
      model: CHECK_MODEL,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify({ lines: [{ beatId: "b1", text: "Eins." }, { beatId: "b4", text: "Er macht 4 Smoothies in unter 2 Minuten." }] }) },
        },
      ],
      usage: { prompt_tokens: 2100, completion_tokens: 40, total_tokens: 2140, cost: 0.0024 },
    };
    const { gateway, requests } = gatewayFor([json(200, incomplete), json(200, complete)]);
    const outcome = await runRole(deps(gateway, ledger), variantWriter, request(twoBeats));
    assert.equal(outcome.status, "done");
    assert.equal(requests.length, 2);
    if (outcome.status !== "done") return;
    assert.ok("lines" in outcome.value);
    assert.equal(outcome.value.lines.length, 2);
    assert.equal(outcome.calls.length, 2);
  });

  it("fails the stage when the retry answers wrongly too", async () => {
    const ledger = await ledgerWith(0.05);
    const bad = { id: "gen-x", model: CHECK_MODEL, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ lines: [{ beatId: "b9", text: "Nope." }] }) } }], usage: { prompt_tokens: 1900, completion_tokens: 20, total_tokens: 1920, cost: 0.002 } };
    const { gateway } = gatewayFor([json(200, bad), json(200, bad)]);
    await assert.rejects(runRole(deps(gateway, ledger), variantWriter, request(languageInput())), (error: unknown) => {
      return error instanceof RoleAnswerError && error.kind === "provider" && error.retryable === false;
    });
  });
});
