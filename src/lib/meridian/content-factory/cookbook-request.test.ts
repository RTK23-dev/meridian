// Applying a cookbook to a request (K12): the style when the cookbook names one, the length as a cap, the instructions in the brief or the change
// lines, and a request that no longer fits the engine's limits reported as incomplete.

import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryPresetCookbook } from "../cookbooks/builtin/factory-presets.ts";
import { threeDDataExplainerCookbook } from "../cookbooks/builtin/three-d-data-explainer.ts";
import { resolveCookbook, type ResolvedCookbook } from "../cookbooks/resolve.ts";
import { applyCookbook } from "./cookbook-request.ts";
import type { RequestBuild } from "./request.ts";

function resolved(cookbook: Parameters<typeof resolveCookbook>[0], lengthMs = 60000): ResolvedCookbook {
  const result = resolveCookbook(cookbook, { lengthMs });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

function candidate(extra: Record<string, unknown> = {}): RequestBuild {
  return {
    status: "incomplete",
    candidate: {
      schema: "meridian.production_request/v1",
      requestId: "req_01HZX3K9M0Q7V8W6Y5T4R3E2D1",
      workspaceId: "ws_1",
      format: { formatId: "ref_abc", referenceVideo: "store://ref/1.mp4", keep: [], change: [] },
      brief: { text: "Show the parking lots.", sources: [], attachments: [] },
      visualRequests: [],
      page: { pageId: "page_1", styleKitId: "sk_theme", voiceId: "voice_1" },
      constraints: { aspect: "9:16", maxMs: 90000, budgetUsd: 20, priority: "normal" },
      output: { master: true },
      ...extra,
    },
    problems: [],
  };
}

test("a cookbook that names a style replaces the theme page's kit, and its length caps the request", () => {
  const result = applyCookbook(candidate(), resolved(threeDDataExplainerCookbook, 60000));
  assert.equal(result.status, "ready", result.status === "incomplete" ? result.problems.join("; ") : "");
  if (result.status !== "ready") return;
  assert.equal(result.request.page.styleKitId, "sk_3d_data_explainer");
  assert.equal(result.request.constraints.maxMs, 60000, "the shorter of the person's cap (90 s) and the cookbook's length (60 s)");
  assert.match(result.request.brief?.text ?? "", /Cookbook instructions \(3D data explainer/);
});

test("a factory preset names no style, so the theme page's kit stands", () => {
  const result = applyCookbook(candidate(), resolved(factoryPresetCookbook("viral_ugc")));
  const kit = result.status === "ready" ? result.request.page.styleKitId : (result.candidate.page as Record<string, unknown>).styleKitId;
  assert.equal(kit, "sk_theme");
});

test("a request with its brief over the limit is reported as incomplete, with the cause in words", () => {
  const long = candidate({ brief: { text: "x".repeat(7990), sources: [], attachments: [] } });
  const result = applyCookbook(long, resolved(threeDDataExplainerCookbook));
  assert.equal(result.status, "incomplete");
  if (result.status === "incomplete") assert.ok(result.problems.some((problem) => problem.includes("do not fit the brief's limit")));
});

test("the input is not changed", () => {
  const input = candidate();
  const before = JSON.stringify(input);
  applyCookbook(input, resolved(threeDDataExplainerCookbook));
  assert.equal(JSON.stringify(input), before);
});

test("with direction, the codex's script rules join the cookbook's own script instruction, and nothing else changes", () => {
  const plain = applyCookbook(candidate(), resolved(threeDDataExplainerCookbook));
  const directed = applyCookbook(candidate(), resolved(threeDDataExplainerCookbook), { direction: { format: "metaphor_explainer", niche: "education" } });
  assert.equal(plain.status, "ready");
  assert.equal(directed.status, "ready", directed.status === "incomplete" ? directed.problems.join("; ") : "");
  if (plain.status !== "ready" || directed.status !== "ready") return;
  const own = plain.request.cookbook?.instructions.script ?? "";
  const script = directed.request.cookbook?.instructions.script ?? "";
  assert.ok(script.startsWith(own), "the cookbook's own instruction comes first, whole");
  assert.match(script, /Direction \(direction-codex@1\)/);
  assert.match(script, /Format: Explainer with a visual metaphor/);
  assert.ok(script.length <= 4000);
  assert.deepEqual(
    { ...directed.request, cookbook: { ...directed.request.cookbook, instructions: { ...directed.request.cookbook?.instructions, script: own } } },
    plain.request,
    "only the script instruction differs",
  );
});
