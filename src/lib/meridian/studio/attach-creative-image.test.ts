import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-attach-creative-image";

// creative-actions.ts uses the "@/" alias, so the alias hook is registered before the module is loaded.
enableAppAliases();
const { attachCreativeImageFor } = await import("./creative-actions.ts");

const NANO_BANANA_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** A minimal PNG header with a 512 x 1024 size. The image checks accept it, as the provider tests do. */
function pngBytes(): Uint8Array {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  new DataView(png.buffer).setUint32(16, 512);
  new DataView(png.buffer).setUint32(20, 1024);
  return png;
}

/** A tenant with one creative to illustrate. The creative belongs to the brand, so the workspace key is the brand's. */
async function creativeFor(label: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  const creativeId = `creative-${randomUUID()}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, hook, status, brief_id, created_by
    ) values (
      ${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Kitchen sponge',
      'Mesh sponges that do not smell.', 'Tired of smelly sponges?', 'generated', ${tenant.briefId}, ${tenant.userId}
    )
  `;
  return { sql, tenant, creativeId };
}

test("attachCreativeImage sends the creative's workspace key to the image provider, and no other key", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-key");
  await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "attach-workspace-key-1111" });

  const requests: Headers[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== NANO_BANANA_URL) return new Response("unexpected request", { status: 500 });
    requests.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ output_image: { data: Buffer.from(pngBytes()).toString("base64"), mime_type: "image/png" } }), { status: 200 });
  });
  try {
    const result = await attachCreativeImageFor(tenant.userId, { brandId: tenant.brandId, creativeId });
    assert.equal(result.status, "stored", "the image is generated and stored");
    assert.equal(requests.length, 1, "exactly one image request is sent");
    assert.equal(requests[0].get("x-goog-api-key"), "attach-workspace-key-1111", "the request carries the workspace's own key");
  } finally {
    fetchMock.mock.restore();
  }
});

test("attachCreativeImage sends nothing when the creative's workspace has no usable key", async () => {
  const { tenant, creativeId } = await creativeFor("attach-nokey");

  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("unexpected request", { status: 500 });
  });
  try {
    const result = await attachCreativeImageFor(tenant.userId, { brandId: tenant.brandId, creativeId });
    assert.equal(result.status, "NOT_CONNECTED", "without a usable key the image is not generated");
    assert.equal(calls, 0, "no request is sent without a workspace key");
  } finally {
    fetchMock.mock.restore();
  }
});
