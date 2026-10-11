import assert from "node:assert/strict";
import test from "node:test";
import { mediaByCreative, primaryMedia, type LibraryCreative, type LibraryMediaVariant } from "./library-model.ts";

function creative(id: string, assetId: string | null): LibraryCreative {
  return { id, title: id, origin: "generated", angle: "", hook: "", status: "approved", createdAt: "2026-01-01T00:00:00Z", assetId, assetKind: assetId ? "image" : "", assetMediaStatus: assetId ? "completed" : "" };
}

function variant(creativeId: string, assetId: string, index: number): LibraryMediaVariant {
  return { creativeId, assetId, kind: "image", index, provider: "p", model: "m", mediaStatus: "completed", qaDecision: "", width: 800, height: 600, durationMs: null };
}

test("studio variants win for a creative they cover, and the listing fills the rest", () => {
  const groups = mediaByCreative(
    [creative("a", "asset-listed-a"), creative("b", "asset-listed-b"), creative("c", null)],
    [variant("a", "asset-studio-a", 0)],
  );
  assert.deepEqual(groups.get("a")?.map((item) => item.assetId), ["asset-studio-a"], "the studio's variant is used, not the listing's");
  assert.equal(groups.get("b")?.[0]?.assetId, "asset-listed-b", "a creative the studio does not list uses the listing's asset id");
  assert.equal(groups.get("b")?.[0]?.width, null, "the fallback carries no dimensions it does not have");
  assert.equal(groups.has("c"), false, "a creative with no stored asset gets no media, not an empty id");
});

test("the fallback media is previewable only when its status says it was kept", () => {
  const groups = mediaByCreative([creative("b", "asset-b")], []);
  assert.equal(primaryMedia(groups.get("b") ?? [])?.assetId, "asset-b");
  const failed = mediaByCreative([{ ...creative("b", "asset-b"), assetMediaStatus: "failed" }], []);
  assert.equal(primaryMedia(failed.get("b") ?? []), null);
});
