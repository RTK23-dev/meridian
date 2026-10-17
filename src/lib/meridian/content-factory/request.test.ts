// The mapping from a Content Factory session to the engine's production request. The engine's own schema decides; each missing field is
// named in plain words, and nothing is defaulted.

import assert from "node:assert/strict";
import { test } from "node:test";
import { requestProblems } from "../../../engine/api/index.ts";
import type { Attachment, Message, SessionSettings } from "./model.ts";
import { buildProductionRequest, problemWords, type SessionForRequest } from "./request.ts";

const REFERENCE: Attachment = {
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
  createdAt: "2026-10-16T10:00:00.000Z",
};

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

const SETTINGS: SessionSettings = { budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: ["hook_mechanism", "pacing"] };

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
      message("Make it feel like the reference, but for our blender.", null, [REFERENCE, SOURCE]),
      message("Your smoothie is lying to you.", "hook"),
      message("Send BLEND for the link.", "cta"),
    ],
    themePage: { pageId: "page-1", styleKitId: "style-1", personaId: null, voiceId: "voice-1" },
    ...overrides,
  };
}

test("a complete session maps to a request the engine's schema accepts", () => {
  const built = buildProductionRequest(session());
  assert.equal(built.status, "ready");
  if (built.status !== "ready") return;
  const request = built.request;
  assert.deepEqual(requestProblems(request), []);
  assert.equal(request.workspaceId, "org-1");
  assert.match(request.requestId, /^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(request.format.referenceVideo, `store://${REFERENCE.kind === "file" ? REFERENCE.storageKey : ""}`);
  assert.equal(request.format.formatId, `ref_${"b".repeat(24)}`);
  assert.deepEqual(request.format.keep, ["hook_mechanism", "pacing"]);
  assert.deepEqual(request.format.change, ["Make it feel like the reference, but for our blender.", "Context from Products: Blender X · Benefits: quiet"]);
  assert.deepEqual(request.script?.beats, [
    { beatId: "b1", role: "hook", text: "Your smoothie is lying to you." },
    { beatId: "b2", role: "cta", text: "Send BLEND for the link." },
  ]);
  assert.deepEqual(request.page, { pageId: "page-1", styleKitId: "style-1", voiceId: "voice-1" }, "a kit the page does not set stays absent");
  assert.deepEqual(request.constraints, { aspect: "9:16", maxMs: 30_000, budgetUsd: 4, priority: "normal" });
  assert.deepEqual(request.output, { master: true });
  const again = buildProductionRequest(session());
  assert.equal(again.status === "ready" ? again.request.requestId : null, request.requestId, "the same session gives the same request id");
});

test("a session with no reference video is refused by the schema, and the refusal says to attach one", () => {
  const built = buildProductionRequest(session({ messages: [message("An idea.", null), message("Hook line.", "hook")] }));
  assert.equal(built.status, "incomplete");
  if (built.status !== "incomplete") return;
  assert.ok(built.problems.includes(problemWords("format.referenceVideo")), built.problems.join(" | "));
  assert.ok(built.problems.includes(problemWords("format.formatId")));
  assert.equal((built.candidate.format as Record<string, unknown>).referenceVideo, undefined, "no reference is invented");
});

test("a session with no script line, no page and no settings names each missing field, and defaults none of them", () => {
  const built = buildProductionRequest(
    session({
      settings: { budgetUsd: null, maxSeconds: null, language: null, priority: null, keepGenes: [] },
      messages: [message("Just an idea.", null, [REFERENCE])],
      themePage: null,
    }),
  );
  assert.equal(built.status, "incomplete");
  if (built.status !== "incomplete") return;
  for (const path of ["script.beats", "script.language", "page.pageId", "constraints.maxMs", "constraints.budgetUsd", "constraints.priority"]) {
    assert.ok(built.problems.includes(problemWords(path)), `${path}: ${built.problems.join(" | ")}`);
  }
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

test("an unknown schema path is still named", () => {
  assert.equal(problemWords("output.variants"), "The engine needs a valid value for output.variants.");
  assert.match(problemWords("script.beats.0.text"), /script line is empty/);
});
