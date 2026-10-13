import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { signMediaLink } from "./media-link.ts";
import { serveSignedCreative } from "./signed-creative.ts";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000;
const CREATIVE = "cr-approved-1";

function linkRequest(creativeId: string, expires: number, sig: string): Request {
  return new Request(`https://media.example.test/api/media-links/${creativeId}?expires=${expires}&sig=${sig}`);
}

/** A database that fails the test if it is read. A refused link must never reach it. */
const untouchedSql = (async () => {
  throw new Error("the database must not be read for a link that does not verify");
}) as unknown as () => Promise<Sql>;

/** A database that answers every query with no rows, so an unknown creative is found nowhere. */
const emptySql = (async () => (async () => [])) as unknown as () => Promise<Sql>;

function baseInput(overrides: Partial<Parameters<typeof serveSignedCreative>[0]> = {}) {
  return {
    request: linkRequest(CREATIVE, NOW + 600, "0".repeat(64)),
    creativeId: CREATIVE,
    getSql: untouchedSql,
    loadArtifactFiles: async () => ({ get: async () => ({ bytes: new Uint8Array() }) }),
    nowSeconds: () => NOW,
    secret: SECRET,
    ...overrides,
  };
}

test("a link with a bad signature is refused before the database is read", async () => {
  const response = await serveSignedCreative(baseInput());
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "This link is not valid.");
});

test("an expired link is refused with the expiry reason, before the database is read", async () => {
  const token = signMediaLink({ creativeId: CREATIVE, nowSeconds: NOW - 3600, secret: SECRET });
  const response = await serveSignedCreative(
    baseInput({ request: linkRequest(CREATIVE, token.expires, token.sig) }),
  );
  assert.equal(response.status, 403);
  assert.match(await response.text(), /expired/);
});

test("a link signed for another creative is refused, so a link cannot be reused across files", async () => {
  const token = signMediaLink({ creativeId: "cr-other", nowSeconds: NOW, secret: SECRET });
  const response = await serveSignedCreative(
    baseInput({ request: linkRequest(CREATIVE, token.expires, token.sig) }),
  );
  assert.equal(response.status, 403);
});

test("with no secret configured, every link answers as not found, and nothing is read", async () => {
  const token = signMediaLink({ creativeId: CREATIVE, nowSeconds: NOW, secret: SECRET });
  const response = await serveSignedCreative(
    baseInput({ request: linkRequest(CREATIVE, token.expires, token.sig), secret: null }),
  );
  assert.equal(response.status, 404);
});

test("a verified link to a creative that does not exist is not found", async () => {
  const token = signMediaLink({ creativeId: "cr-missing", nowSeconds: NOW, secret: SECRET });
  const response = await serveSignedCreative(
    baseInput({
      request: linkRequest("cr-missing", token.expires, token.sig),
      creativeId: "cr-missing",
      getSql: emptySql,
    }),
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});
