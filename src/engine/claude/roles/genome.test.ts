import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { angleBibleEntries } from "../../analyze/angle-bible.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { estimateClaudeUsd } from "../rates.ts";
import {
  angleBibleReference,
  genome,
  genomeAnswerSchema,
  genomeInputSchema,
  genomeUserContent,
  type GenomeInput,
} from "./genome.ts";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "analyze",
  "test",
  "fixtures",
);

/** The recorded answer's content string, parsed (the shape the gateway hands the role). */
function recordedAnswer(name: string): unknown {
  const body = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
    choices: Array<{ message: { content: string } }>;
  };
  return JSON.parse(body.choices[0]?.message.content ?? "null");
}

const transcript = [
  { wordId: "w1", text: "Watch", startMs: 100, endMs: 400, confidence: 0.97 },
  { wordId: "w2", text: "this", startMs: 450, endMs: 700, confidence: 0.98 },
  { wordId: "w3", text: "blender", startMs: 720, endMs: 1200, confidence: 0.96 },
];

function input(): GenomeInput {
  return genomeInputSchema.parse({
    durationMs: 6000,
    segments: [
      {
        segId: "s1",
        startMs: 0,
        endMs: 1533,
        shotType: "talking_head",
        layers: { base: "a presenter facing the camera" },
        beatRole: "hook",
        motion: 0.1,
        brightness: 0.4,
        loudnessLufs: -20,
      },
    ],
    transcript,
    angleBible: angleBibleEntries(),
  });
}

describe("the genome role (Bible 6.2 step 5, 11.1)", () => {
  it("is an analysis call on genome@1, Sonnet, with the 15k in and 2k out estimate", () => {
    assert.equal(genome.capability, "llm.analysis");
    assert.equal(genome.prompt.role, "genome");
    assert.equal(genome.prompt.version, 1);
    assert.equal(genome.maxOutputTokens, 2000);
    assert.equal(estimateClaudeUsd("anthropic/claude-sonnet-5.5", genome.estimateTokens), 0.05);
  });

  it("accepts the recorded answer: Angle Bible slugs, transferable genes and labels that name a kind of content", () => {
    const parsed = genomeAnswerSchema(input()).safeParse(recordedAnswer("openrouter-genome.json"));
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  });

  it("refuses a genome value that is not an Angle Bible slug, so no free text is stored", () => {
    const answer = {
      genome: { hook_mechanism: "a sentence the model wrote" },
      transferable: [],
      notTransferable: [],
    };
    const result = genomeAnswerSchema(input()).safeParse(answer);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map((issue) => issue.path.join(".")),
      ["genome.hook_mechanism"],
    );
  });

  it("refuses a label that repeats the transcript, at its path (a copy of content is not a gene)", () => {
    const result = genomeAnswerSchema(input()).safeParse(
      recordedAnswer("openrouter-genome-copies.json"),
    );
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error?.issues.map((issue) => issue.path.join(".")),
      ["notTransferable.0"],
    );
  });

  it("refuses a gene listed twice as transferable", () => {
    const answer = { genome: {}, transferable: ["pacing", "pacing"], notTransferable: [] };
    const result = genomeAnswerSchema(input()).safeParse(answer);
    assert.deepEqual(
      result.error?.issues.map((issue) => issue.path.join(".")),
      ["transferable.1"],
    );
  });

  it("lists the Angle Bible entries as reference, with each slug once", () => {
    const entries = angleBibleEntries();
    const slugs = entries.map((entry) => entry.slug);
    assert.ok(slugs.includes("result-first"));
    assert.equal(new Set(slugs).size, slugs.length);
    assert.match(angleBibleReference(entries), /^Angle Bible entries/);
  });

  it("sends the segments and the transcript as untrusted data blocks, after the reference", () => {
    const parts = genomeUserContent(input());
    const texts = parts.map((part) => (part.type === "text" ? part.text : ""));
    assert.match(texts.join("\n"), /<untrusted-data name="segments">/);
    assert.match(texts.join("\n"), /<untrusted-data name="transcript">/);
    assert.ok(
      texts.findIndex((text) => text.startsWith("Angle Bible entries")) <
        texts.findIndex((text) => text.includes('name="segments"')),
    );
  });

  it("sends the schema without the words of a segment", () => {
    const schema = JSON.stringify(jsonSchemaFor(genomeAnswerSchema(input())));
    assert.match(schema, /"transferable"/);
    assert.doesNotMatch(schema, /"wordIds"|"onScreenText"/);
  });

  it("pins the bytes of genome@1, so a shipped version is changed only by a new version", () => {
    assert.equal(
      loadPrompt(genome.prompt).fileHash,
      "sha256:a2fa10ad01ea0addd42fe68bf53205c209b9193fbec0b56a67b828ae49c5ec05",
    );
  });
});
