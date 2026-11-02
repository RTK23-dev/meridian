import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogRead, ModelCatalogSource } from "./catalog.ts";
import { withModelPolicy, withoutDisabledRows } from "./catalog-policy.ts";

/** A read with three entries and a video listing. Only the fields the policy touches are filled in. */
function readWith(): CatalogRead {
  const entries = [{ id: "google/veo-3.1-fast" }, { id: "kwaivgi/kling-v3.0-std" }, { id: "google/gemini-3.8-flash-tts" }];
  const videoListing = { data: [{ id: "google/veo-3.1-fast" }, { id: "kwaivgi/kling-v3.0-std" }], extra: true };
  return { status: "read", catalog: { readAt: "2026-10-23T00:00:00.000Z", entries, dropped: [], failed: [], videoListing } } as unknown as CatalogRead;
}

function sourceOf(read: CatalogRead): ModelCatalogSource {
  return { async read() { return read; } };
}

test("a switched-off family is removed from the entries and from the video listing", async () => {
  const source = withModelPolicy(sourceOf(readWith()), async () => ["google/veo"]);
  const read = await source.read("org_a");
  assert.equal(read.status, "read");
  if (read.status !== "read") return;
  assert.deepEqual(read.catalog.entries.map((entry) => entry.id), ["kwaivgi/kling-v3.0-std", "google/gemini-3.8-flash-tts"]);
  assert.deepEqual(read.catalog.videoListing, { data: [{ id: "kwaivgi/kling-v3.0-std" }], extra: true });
});

test("the families are read on every call, so a change in Settings applies at once", async () => {
  let families: string[] = ["google/veo"];
  const source = withModelPolicy(sourceOf(readWith()), async () => families);
  const first = await source.read("org_a");
  families = [];
  const second = await source.read("org_a");
  assert.equal(first.status === "read" && first.catalog.entries.length, 2);
  assert.equal(second.status === "read" && second.catalog.entries.length, 3, "Veo is back once it is switched on");
});

test("with no family switched off, the read is the same object, and a failed read passes through", async () => {
  const read = readWith();
  assert.equal(await withModelPolicy(sourceOf(read), async () => []).read("org_a"), read);
  const failed = { status: "not_connected", reason: "no key" } as CatalogRead;
  assert.equal(await withModelPolicy(sourceOf(failed), async () => ["google/veo"]).read("org_a"), failed);
});

test("withoutDisabledRows leaves a listing with no data array as it is", () => {
  const listing = { models: [{ id: "google/veo-3.1-fast" }] };
  assert.equal(withoutDisabledRows(listing, ["google/veo"]), listing);
  assert.equal(withoutDisabledRows(null, ["google/veo"]), null);
});
