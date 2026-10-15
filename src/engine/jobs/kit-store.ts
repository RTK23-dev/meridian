// The kit store (Bible 5.4 engine_kits, 13): the style, persona, character, product and voice kits a request names. Kits are
// shared by a workspace, not made by one request, so they are not artifacts (an artifact belongs to one request, and the
// artifact types have no kit). They are rows in engine_kits, each body validated against its contract on the way in and out,
// and every query is scoped to the workspace.
//
// Versions: a kit's version is its own field (a voice kit has none, so its version is 1). loadKits returns the highest version
// of each kit a request names, which is what intake validates. The plan and the edit check the versions they are given against
// the validated request (kitMatchCheck, the edit's style kit check), so a kit that changed after intake fails there, not here.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  characterSheetSchema,
  contentHash,
  EngineError,
  personaSchema,
  productKitSchema,
  styleKitSchema,
  voiceKitSchema,
  type CharacterSheet,
  type Persona,
  type ProductKit,
  type StyleKit,
  type ValidatedRequest,
  type VoiceKit,
} from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { EditKitScope } from "./handlers/edit.ts";
import type { KitScope, ResolvedKits } from "./handlers/intake.ts";

export const KIT_KINDS = ["style", "persona", "character", "product", "voice"] as const;
export type KitKind = (typeof KIT_KINDS)[number];

const KIT_SCHEMAS: Record<KitKind, z.ZodType> = {
  style: styleKitSchema,
  persona: personaSchema,
  character: characterSheetSchema,
  product: productKitSchema,
  voice: voiceKitSchema,
};

/** The kit id a body carries under its own name (styleKitId, personaId, and so on). */
function kitIdOf(kind: KitKind, body: Record<string, unknown>): string {
  const field = { style: "styleKitId", persona: "personaId", character: "characterId", product: "productKitId", voice: "voiceId" }[kind];
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new EngineError("invalid_input", `a ${kind} kit has no ${field}`);
  return value;
}

/** A kit's version: its own field, or 1 for a kit that has none (the voice kit). */
function versionOf(body: Record<string, unknown>): number {
  const version = body.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1;
}

export type StoredKit<T> = { body: T; kitId: string; version: number; contentHash: string };

/** Validates a kit body and stores it. The same body twice is one row. Refuses a body that does not match its contract. */
export async function writeKit(sql: Sql, input: { organizationId: string; kind: KitKind; body: unknown }): Promise<StoredKit<unknown>> {
  const parsed = KIT_SCHEMAS[input.kind].safeParse(input.body);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the ${input.kind} kit is not valid: ${parsed.error.message}`);
  }
  const body = parsed.data as Record<string, unknown>;
  const kitId = kitIdOf(input.kind, body);
  const version = versionOf(body);
  const hash = contentHash(body);
  const id = `kit_${createHash("sha256").update(`${input.organizationId}|${input.kind}|${kitId}|${hash}`).digest("hex").slice(0, 40)}`;
  await sql`
    insert into engine_kits (id, organization_id, kind, kit_id, content_hash, body)
    values (${id}, ${input.organizationId}, ${input.kind}, ${kitId}, ${hash}, ${canonicalJson(body)})
    on conflict (organization_id, kind, kit_id, content_hash) do nothing
  `;
  return { body, kitId, version, contentHash: hash };
}

/**
 * Reads one kit of a workspace. With a version, the row of that version; without one, the highest version (the newest row when two
 * share it). Null when the workspace has no such kit. A stored body that no longer matches its contract is an internal error.
 */
export async function readKit<T>(
  sql: Sql,
  input: { organizationId: string; kind: KitKind; kitId: string; version?: number },
): Promise<StoredKit<T> | null> {
  const rows = await sql<{ body: string; content_hash: string }>`
    select body, content_hash from engine_kits
    where organization_id = ${input.organizationId} and kind = ${input.kind} and kit_id = ${input.kitId}
    order by created_at desc, id asc
  `;
  let best: StoredKit<T> | null = null;
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.body);
    } catch (error) {
      throw new EngineError("internal", `the stored ${input.kind} kit ${input.kitId} is not JSON`, { cause: error });
    }
    const parsed = KIT_SCHEMAS[input.kind].safeParse(raw);
    if (!parsed.success) throw new EngineError("internal", `the stored ${input.kind} kit ${input.kitId} no longer matches its contract`);
    const body = parsed.data as Record<string, unknown>;
    const version = versionOf(body);
    if (input.version !== undefined && version !== input.version) continue;
    if (best === null || version > best.version) {
      best = { body: parsed.data as T, kitId: input.kitId, version, contentHash: row.content_hash };
    }
  }
  return best;
}

/**
 * The kit ports of the stages, over one workspace's kit rows. loadKits gives intake and plan the highest version of each kit the
 * request names (a kit that did not load is absent, and the gates say so). loadStyleKit gives the edit the exact style kit version
 * the validated request names: a kit of another version is returned as is, and the edit gate refuses it.
 */
export function kitPorts(sql: Sql): {
  loadKits: (scope: KitScope) => Promise<ResolvedKits>;
  loadStyleKit: (scope: EditKitScope) => Promise<StyleKit | undefined>;
} {
  return {
    async loadKits({ organizationId, request }) {
      const scope = { organizationId };
      const styleKit = await readKit<StyleKit>(sql, { ...scope, kind: "style", kitId: request.page.styleKitId });
      const persona = request.page.personaId === undefined ? null : await readKit<Persona>(sql, { ...scope, kind: "persona", kitId: request.page.personaId });
      const voice = await readKit<VoiceKit>(sql, { ...scope, kind: "voice", kitId: request.page.voiceId });
      const characters: CharacterSheet[] = [];
      for (const characterId of request.page.characterIds ?? []) {
        const found = await readKit<CharacterSheet>(sql, { ...scope, kind: "character", kitId: characterId });
        if (found !== null) characters.push(found.body);
      }
      const productKit =
        request.product === undefined ? null : await readKit<ProductKit>(sql, { ...scope, kind: "product", kitId: request.product.productKitId });
      return {
        ...(styleKit === null ? {} : { styleKit: styleKit.body }),
        ...(persona === null ? {} : { persona: persona.body }),
        ...(voice === null ? {} : { voice: voice.body }),
        characters,
        ...(productKit === null ? {} : { productKit: productKit.body }),
      };
    },
    async loadStyleKit({ organizationId, validated }: { organizationId: string; validated: ValidatedRequest }) {
      const ref = validated.kits.styleKit;
      const found = await readKit<StyleKit>(sql, { organizationId, kind: "style", kitId: ref.id, version: ref.version });
      return found?.body;
    },
  };
}

/**
 * The product kit of a SKU in this workspace: the highest version of the kit whose sku is the SKU, or undefined when the workspace has no
 * such kit. A variant names a SKU, not a kit id, so this reads the workspace's product kits and matches the body. Each stored body is
 * validated on the way out, as readKit does; a body that no longer matches its contract is an internal error.
 */
export async function productKitBySku(sql: Sql, input: { organizationId: string; sku: string }): Promise<ProductKit | undefined> {
  const rows = await sql<{ body: string }>`
    select body from engine_kits
    where organization_id = ${input.organizationId} and kind = 'product'
    order by created_at desc, id asc
  `;
  let best: ProductKit | undefined;
  let bestVersion = 0;
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.body);
    } catch (error) {
      throw new EngineError("internal", "a stored product kit is not JSON", { cause: error });
    }
    const parsed = productKitSchema.safeParse(raw);
    if (!parsed.success) throw new EngineError("internal", "a stored product kit no longer matches its contract");
    if (parsed.data.sku !== input.sku) continue;
    const version = versionOf(parsed.data as unknown as Record<string, unknown>);
    if (best === undefined || version > bestVersion) {
      best = parsed.data;
      bestVersion = version;
    }
  }
  return best;
}
