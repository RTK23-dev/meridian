import assert from "node:assert/strict";
import test from "node:test";
import { sourceRegistry } from "./registry.ts";

test("sourceRegistry contains all configured adapters", () => {
  const adapters = sourceRegistry.list();
  assert.ok(adapters.length >= 8);

  const instagram = sourceRegistry.get("instagram");
  assert.ok(instagram);
  assert.equal(instagram.platform, "instagram");

  const upload = sourceRegistry.get("upload");
  assert.ok(upload);
  assert.equal(upload.platform, "upload");

  const search = sourceRegistry.get("search");
  assert.ok(search);
  assert.equal(search.platform, "search");
});

test("source adapters report NOT_CONFIGURED when API tokens are missing", async () => {
  const originalMeta = process.env.META_ACCESS_TOKEN;
  const originalInsta = process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.META_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;

  try {
    const instagram = sourceRegistry.get("instagram");
    assert.ok(instagram);
    const health = await instagram.health();
    assert.equal(health.status, "NOT_CONFIGURED");
  } finally {
    if (originalMeta) process.env.META_ACCESS_TOKEN = originalMeta;
    if (originalInsta) process.env.INSTAGRAM_ACCESS_TOKEN = originalInsta;
  }
});
