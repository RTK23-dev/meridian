// The mapping from a Content Factory session to the engine's production request (contract v8). A session is a brief by default, and a
// script when the person marked script lines. A text file is read into the brief as a source; a PDF stays an attachment with its note.
// The engine's own schema decides; each missing field is named in plain words, and nothing is defaulted.

import assert from "node:assert/strict";
import { test } from "node:test";
import { requestProblems } from "../../../engine/api/index.ts";
import { BRIEF_SOURCE_TEXT_MAX, BRIEF_TEXT_MAX } from "../../../engine/contracts/request.ts";
import type { Attachment, FileAttachment, Message, SessionSettings } from "./model.ts";
import { TEXT_FILE_MAX_CHARS } from "./model.ts";
import { buildProductionRequest, inputNotes, problemWords, type SessionForRequest } from "./request.ts";

const REFERENCE: FileAttachment = {
  id: "att-ref",
  kind: "file",
  messageId: "m1",
  purpose: "reference_video",
  fileName: "reel.mp4",
  storageObjectId: "org:brand:key",
  storageKey: `content-factory/sess-1/${"b".repeat(64)}.mp4`,
  mediaType: "video/mp4",
  bytes: 2048,
  sha256: "b".repeat(64),
  content: null,
  createdAt: "2026-10-16T10:00:00.000Z",
};

const IMAGE: Attachment = { ...REFERENCE, id: "att-img", purpose: "material", fileName: "product.png", storageKey: `content-factory/sess-1/${"c".repeat(64)}.png`, mediaType: "image/png", sha256: "c".repeat(64) };
const PDF: Attachment = { ...REFERENCE, id: "att-pdf", purpose: "material", fileName: "specs.pdf", storageKey: `content-factory/sess-1/${"d".repeat(64)}.pdf`, mediaType: "application/pdf", sha256: "d".repeat(64) };

/** A text file of the session, with its content read into the brief. */
function textFile(content: string, fileName = "angle.txt"): Attachment {
  return {
    ...REFERENCE,
    id: `att-${fileName}`,
    purpose: "material",
    fileName,
    storageKey: `content-factory/sess-1/${"e".repeat(64)}.txt`,
    mediaType: "text/plain",
    bytes: content.length,
    sha256: "e".repeat(64),
    content,
  };
}

const SOURCE: Attachment = {
  id: "att-src",
  kind: "source",
  messageId: "m1",
  page: "product",
  brandId: "brand-1",
  recordId: "prod-1",
  snapshot: "Blender X · Benefits: quiet",
  createdAt: "2026-10-16T10:00:00.000Z",
};

const SETTINGS: SessionSettings = { budgetUsd: 4, maxSeconds: 30, language: null, priority: "normal", keepGenes: ["hook_mechanism", "pacing"] };

function message(text: string, beatRole: Message["beatRole"], attachments: Attachment[] = []): SessionForRequest["messages"][number] {
  return { text, beatRole, attachments };
}

function session(overrides: Partial<SessionForRequest> = {}): SessionForRequest {
  return {
    id: "sess-1",
    organizationId: "org-1",
    createdAt: "2026-10-16T09:00:00.000Z",
    settings: SETTINGS,
    messages: [
      message("Make it feel like the reference, but for our blender.", null, [REFERENCE, IMAGE, SOURCE]),
      message("Lead with the noise test.", null, [PDF]),
    ],
    themePage: { pageId: "page-1", styleKitId: "style-1", personaId: null, voiceId: "voice-1" },
    ...overrides,
  };
}

test("a session with instructions and no script lines maps to a brief the engine's schema accepts", () => {
  const built = buildProductionRequest(session());
  assert.equal(built.status, "ready", built.status === "incomplete" ? built.problems.join(" | ") : "");
  if (built.status !== "ready") return;
  const request = built.request;
  assert.deepEqual(requestProblems(request), []);
  assert.equal(request.script, undefined, "a brief request carries no script");
  assert.deepEqual(request.brief, {
    text: "Make it feel like the reference, but for our blender.\n\nLead with the noise test.",
    sources: [{ label: "Products", text: "Blender X · Benefits: quiet" }],
    attachments: [
      { uri: `store://content-factory/sess-1/${"c".repeat(64)}.png`, mediaType: "image/png", note: "product.png" },
      {
        uri: `store://content-factory/sess-1/${"d".repeat(64)}.pdf`,
        mediaType: "application/pdf",
        note: "specs.pdf: PDF text is not read yet; the file is kept with the session.",
      },
    ],
  });
  assert.equal(request.workspaceId, "org-1");
  assert.match(request.requestId, /^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(request.format.referenceVideo, `store://content-factory/sess-1/${"b".repeat(64)}.mp4`, "the reference is the format, never a brief attachment");
  assert.equal(request.format.formatId, `ref_${"b".repeat(24)}`);
  assert.deepEqual(request.format.keep, ["hook_mechanism", "pacing"]);
  assert.deepEqual(request.format.change, []);
  assert.deepEqual(request.page, { pageId: "page-1", styleKitId: "style-1", voiceId: "voice-1" }, "a kit the page does not set stays absent");
  assert.deepEqual(request.constraints, { aspect: "9:16", maxMs: 30_000, budgetUsd: 4, priority: "normal" });
  assert.deepEqual(request.output, { master: true });
  const again = buildProductionRequest(session());
  assert.equal(again.status === "ready" ? again.request.requestId : null, request.requestId, "the same session gives the same request id");
});

test("script lines make a script request instead of a brief, never both, and need their language", () => {
  const scripted = session({
    messages: [
      message("Make it feel like the reference, but for our blender.", null, [REFERENCE, SOURCE]),
      message("Your smoothie is lying to you.", "hook"),
      message("Send BLEND for the link.", "cta"),
    ],
  });
  const noLanguage = buildProductionRequest(scripted);
  assert.equal(noLanguage.status, "incomplete");
  assert.deepEqual(noLanguage.status === "incomplete" ? noLanguage.problems : [], [problemWords("script.language")]);

  const built = buildProductionRequest({ ...scripted, settings: { ...SETTINGS, language: "en" } });
  assert.equal(built.status, "ready");
  if (built.status !== "ready") return;
  assert.equal(built.request.brief, undefined);
  assert.deepEqual(built.request.script, {
    language: "en",
    beats: [
      { beatId: "b1", role: "hook", text: "Your smoothie is lying to you." },
      { beatId: "b2", role: "cta", text: "Send BLEND for the link." },
    ],
  });
  assert.deepEqual(built.request.format.change, ["Make it feel like the reference, but for our blender.", "Context from Products: Blender X · Benefits: quiet"]);
});

test("a session with no reference video is refused by the schema, and the refusal says to attach one", () => {
  const built = buildProductionRequest(session({ messages: [message("An idea.", null)] }));
  assert.equal(built.status, "incomplete");
  if (built.status !== "incomplete") return;
  assert.deepEqual(built.problems, [problemWords("format.referenceVideo")]);
  assert.equal((built.candidate.format as Record<string, unknown>).referenceVideo, undefined, "no reference is invented");
});

test("a session with no instruction, no page and no settings names each missing field, and asks for no language", () => {
  const built = buildProductionRequest(
    session({
      settings: { budgetUsd: null, maxSeconds: null, language: null, priority: null, keepGenes: [] },
      messages: [message("", null, [REFERENCE])],
      themePage: null,
    }),
  );
  assert.equal(built.status, "incomplete");
  if (built.status !== "incomplete") return;
  for (const path of ["brief.text", "page.pageId", "constraints.maxMs", "constraints.budgetUsd", "constraints.priority"]) {
    assert.ok(built.problems.includes(problemWords(path)), `${path}: ${built.problems.join(" | ")}`);
  }
  assert.equal(built.problems.includes(problemWords("script.language")), false, "the engine chooses the language of a script it writes");
  assert.equal(built.problems.includes(problemWords("page.voiceId")), false, "with no page attached, the page is the one gap named");
  const constraints = built.candidate.constraints as Record<string, unknown>;
  assert.equal(constraints.budgetUsd, undefined, "no budget is assumed");
  assert.equal(constraints.maxMs, undefined);
});

test("a theme page without a voice kit is named as the page's gap", () => {
  const built = buildProductionRequest(session({ themePage: { pageId: "page-1", styleKitId: "style-1", personaId: null, voiceId: null } }));
  assert.equal(built.status, "incomplete");
  if (built.status !== "incomplete") return;
  assert.deepEqual(built.problems, [problemWords("page.voiceId")]);
});

test("more than 20 extra files is refused by the schema in plain words, not cut", () => {
  const files = Array.from({ length: 21 }, (_, index): Attachment => ({ ...IMAGE, id: `img-${index}`, storageKey: `k/${index}.png` }));
  const built = buildProductionRequest(session({ messages: [message("Idea.", null, [REFERENCE, ...files])] }));
  assert.equal(built.status, "incomplete");
  assert.deepEqual(built.status === "incomplete" ? built.problems : [], [problemWords("brief.attachments")]);
});

test("a text file becomes a brief source labelled with its file name, and is not an attachment", () => {
  const built = buildProductionRequest(session({ messages: [message("Make a reel from this angle.", null, [REFERENCE, textFile("Lead with the quiet test, not the price.")])] }));
  assert.equal(built.status, "ready", built.status === "incomplete" ? built.problems.join(" | ") : "");
  if (built.status !== "ready") return;
  assert.deepEqual(built.request.brief, {
    text: "Make a reel from this angle.",
    sources: [{ label: "angle.txt", text: "Lead with the quiet test, not the price." }],
    attachments: [],
  });
  assert.deepEqual(requestProblems(built.request), []);
});

test("a text file at the limit is accepted by the engine's schema, even when each character is two UTF-16 units", () => {
  assert.equal(TEXT_FILE_MAX_CHARS, BRIEF_SOURCE_TEXT_MAX, "the text file limit is the engine's brief source limit");
  const built = buildProductionRequest(session({ messages: [message("Idea.", null, [REFERENCE, textFile("😀".repeat(TEXT_FILE_MAX_CHARS))])] }));
  assert.equal(built.status, "ready", built.status === "incomplete" ? built.problems.join(" | ") : "");
});

test("a PDF stays an attachment, and its note says its text is not read yet", () => {
  const built = buildProductionRequest(session({ messages: [message("Use the specs.", null, [REFERENCE, PDF])] }));
  assert.equal(built.status, "ready", built.status === "incomplete" ? built.problems.join(" | ") : "");
  if (built.status !== "ready") return;
  assert.deepEqual(built.request.brief?.attachments, [
    {
      uri: `store://content-factory/sess-1/${"d".repeat(64)}.pdf`,
      mediaType: "application/pdf",
      note: "specs.pdf: PDF text is not read yet; the file is kept with the session.",
    },
  ]);
  assert.deepEqual(built.request.brief?.sources, []);
});

test("the decision panel's inputs name a text file's length and a PDF's note, and list no image", () => {
  assert.deepEqual(inputNotes([REFERENCE, textFile("a".repeat(27)), PDF, IMAGE]), [
    "angle.txt: read into the brief, 27 characters.",
    "specs.pdf: PDF text is not read yet; the file is kept with the session.",
  ]);
});

test("text files and records share the 20 sources limit, and the limit is named in plain words", () => {
  const records = (count: number): Attachment[] => Array.from({ length: count }, (_, index): Attachment => ({ ...SOURCE, id: `src-${index}`, recordId: `prod-${index}` }));
  const fits = buildProductionRequest(session({ messages: [message("Idea.", null, [REFERENCE, ...records(19), textFile("Hook.")])] }));
  assert.equal(fits.status, "ready", fits.status === "incomplete" ? fits.problems.join(" | ") : "");

  const over = buildProductionRequest(session({ messages: [message("Idea.", null, [REFERENCE, ...records(20), textFile("Hook.")])] }));
  assert.equal(over.status, "incomplete");
  assert.deepEqual(over.status === "incomplete" ? over.problems : [], [problemWords("brief.sources")]);
  assert.match(problemWords("brief.sources"), /records and text files/);
});

test("the instructions and the text files share the brief's total limit", () => {
  const instructions = "x".repeat(BRIEF_TEXT_MAX - 20);
  const fits = buildProductionRequest(session({ messages: [message(instructions, null, [REFERENCE, textFile("y".repeat(20))])] }));
  assert.equal(fits.status, "ready", fits.status === "incomplete" ? fits.problems.join(" | ") : "");

  const over = buildProductionRequest(session({ messages: [message(instructions, null, [REFERENCE, textFile("y".repeat(21))])] }));
  assert.equal(over.status, "incomplete");
  assert.deepEqual(over.status === "incomplete" ? over.problems : [], ["Keep the instructions and text files to 8000 characters in all."]);
});

test("a script request sends a text file as a change line, never as a source", () => {
  const built = buildProductionRequest(
    session({
      settings: { ...SETTINGS, language: "en" },
      messages: [
        message("Make it feel like the reference.", null, [REFERENCE, textFile("Lead with the quiet test.")]),
        message("Your smoothie is lying to you.", "hook"),
        message("Send BLEND for the link.", "cta"),
      ],
    }),
  );
  assert.equal(built.status, "ready", built.status === "incomplete" ? built.problems.join(" | ") : "");
  if (built.status !== "ready") return;
  assert.equal(built.request.brief, undefined);
  assert.deepEqual(built.request.format.change, ["Make it feel like the reference.", "Context from the text file angle.txt: Lead with the quiet test."]);
});

test("an unknown schema path is still named", () => {
  assert.equal(problemWords("output.variants"), "The engine needs a valid value for output.variants.");
  assert.match(problemWords("script.beats.0.text"), /script line is empty/);
});
