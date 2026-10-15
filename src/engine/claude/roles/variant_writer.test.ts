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
} from "./variant_writer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = join(HERE, "..", "..", "prompts", "variant_writer@1.md");

const HAIKU = "anthropic/claude-haiku-5.5";

function languageInput(overrides: Partial<VariantWriterInput> = {}): VariantWriterInput {
  return variantWriterInputSchema.parse({
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
    variant: { attribute: "hook", label: "hook line 2 of 3" },
    targetLanguage: "en",
    beats: [{ beatId: "b1", role: "hook", text: "Your kitchen counter is lying to you.", emphasis: ["lying"] }],
    claims: [],
  });
}

function parseAnswer(input: VariantWriterInput, value: unknown) {
  return variantWriterAnswerSchema(input).safeParse(value);
}

describe("the variant_writer input contract (Bible 6.13, 11.1)", () => {
  it("accepts a hook for one beat and a language for every beat", () => {
    assert.equal(hookInput().beats.length, 1);
    assert.equal(languageInput().beats.length, 2);
  });

  it("refuses a beat id used twice, no beats, and more beats than the limit", () => {
    const beat = { beatId: "b1", role: "hook", text: "Hello there.", emphasis: [] };
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: [beat, beat] }).success, false);
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: [] }).success, false);
    const many = Array.from({ length: 13 }, (_, index) => ({ beatId: `b${index}`, role: "setup", text: "Hello there.", emphasis: [] }));
    assert.equal(variantWriterInputSchema.safeParse({ ...languageInput(), beats: many }).success, false);
  });

  it("refuses an attribute other than hook or language", () => {
    const bad = { ...languageInput(), variant: { attribute: "caption", label: "captions upper" } };
    assert.equal(variantWriterInputSchema.safeParse(bad).success, false);
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
});

describe("the variant_writer role (Bible 11.1)", () => {
  it("is a Haiku check call on variant_writer@1, for the variants stage", () => {
    assert.equal(variantWriter.role, "variant_writer");
    assert.equal(variantWriter.capability, "llm.check");
    assert.equal(variantWriter.stage, "variants");
    assert.deepEqual(VARIANT_WRITER_PROMPT, { role: "variant_writer", version: 1 });
  });

  it("prices one call at Bible 11.1's 2k in and 0.5k out, under one cent", () => {
    assert.deepEqual(VARIANT_WRITER_ESTIMATE_TOKENS, { input: 2000, output: 500 });
    const usd = estimateClaudeUsd(HAIKU, variantWriter.estimateTokens);
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

  it("pins the bytes of variant_writer@1 (a shipped version never changes)", () => {
    const bytes = readFileSync(PROMPT_FILE);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(loadPrompt(variantWriter.prompt).fileHash, hash);
    assert.equal(hash, "sha256:4c2aac567b21387d7e31cb972fdc59dc998f3c9b154c99f9af531a2256f891de");
  });

  it("runs through the Claude client on the request's reservation, and writes the role and version to the ledger", async () => {
    const ledger = await ledgerWith(0.05);
    const body = {
      id: "gen-variant-writer-1",
      model: HAIKU,
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
    assert.equal(outcome.value.lines[0]?.text, "Deine Arbeitsplatte belügt dich.");
    assert.equal(outcome.calls.length, 1);
    assert.equal(outcome.calls[0]?.promptVersion, "variant_writer@1");
    assert.equal(outcome.calls[0]?.costUsd, 0.0019);
    assert.equal(outcome.calls[0]?.actualIsEstimate, false);

    const sent = JSON.parse(String(requests[0]?.body)) as { model: string; max_tokens: number; response_format: { json_schema: { name: string } } };
    assert.equal(sent.model, HAIKU);
    assert.equal(sent.max_tokens, VARIANT_WRITER_MAX_OUTPUT_TOKENS);
    assert.equal(sent.response_format.json_schema.name, "variant_writer_answer");
    assert.match(textOf(sentMessages(requests[0]?.body)[0]?.content), /^# variant_writer@1/);

    const rows = await ledger.listEntries("res_01JABCDEFGHJKMNPQRSTVWXYZ0");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, "variant_writer");
    assert.equal(rows[0]?.promptVersion, "variant_writer@1");
    assert.equal(rows[0]?.actualUsd, 0.0019);
  });

  it("retries once when the first answer drops a beat, and the retry answers", async () => {
    const ledger = await ledgerWith(0.05);
    const twoBeats = languageInput();
    const incomplete = { id: "gen-1", model: HAIKU, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ lines: [{ beatId: "b1", text: "Eins." }] }) } }], usage: { prompt_tokens: 1900, completion_tokens: 20, total_tokens: 1920, cost: 0.002 } };
    const complete = {
      id: "gen-2",
      model: HAIKU,
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
    assert.equal(outcome.value.lines.length, 2);
    assert.equal(outcome.calls.length, 2);
  });

  it("fails the stage when the retry answers wrongly too", async () => {
    const ledger = await ledgerWith(0.05);
    const bad = { id: "gen-x", model: HAIKU, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ lines: [{ beatId: "b9", text: "Nope." }] }) } }], usage: { prompt_tokens: 1900, completion_tokens: 20, total_tokens: 1920, cost: 0.002 } };
    const { gateway } = gatewayFor([json(200, bad), json(200, bad)]);
    await assert.rejects(runRole(deps(gateway, ledger), variantWriter, request(languageInput())), (error: unknown) => {
      return error instanceof RoleAnswerError && error.kind === "provider" && error.retryable === false;
    });
  });
});
