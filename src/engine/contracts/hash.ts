// Canonical JSON and content hashes (Bible section 4 conventions: contentHash is sha256 of the canonical JSON
// or of the file bytes). Canonical JSON sorts keys and has no whitespace, so equal values hash equally.

import { createHash } from "node:crypto";
import { z } from "zod";
import { EngineError } from "./errors.ts";

export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const contentHashSchema = z.string().regex(CONTENT_HASH_PATTERN, {
  message: "contentHash must be sha256:<64 lowercase hex>",
});

function canonicalValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EngineError("invalid_input", "canonicalJson cannot encode NaN or infinite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Matches JSON.stringify: an undefined array slot becomes null.
    return value.map((item) => {
      const canonical = canonicalValue(item);
      return canonical === undefined ? null : canonical;
    });
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EngineError("invalid_input", "canonicalJson accepts plain objects, arrays and JSON values only");
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const canonical = canonicalValue(source[key]);
      if (canonical !== undefined) {
        out[key] = canonical;
      }
    }
    return out;
  }
  throw new EngineError("invalid_input", `canonicalJson cannot encode a value of type ${typeof value}`);
}

/** Deterministic JSON: sorted keys, no whitespace, undefined object members omitted. */
export function canonicalJson(value: unknown): string {
  const canonical = canonicalValue(value);
  if (canonical === undefined) {
    throw new EngineError("invalid_input", "canonicalJson needs a value, got undefined");
  }
  return JSON.stringify(canonical);
}

/** sha256 of the file bytes when given a Uint8Array, otherwise sha256 of the canonical JSON. */
export function contentHash(value: unknown): string {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(canonicalJson(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
