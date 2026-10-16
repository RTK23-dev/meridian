// Versioned role prompts (Bible 11.2 and 11.3): one file per role and version, named prompts/<role>@<n>.md. A prompt is
// read once, checked against its own name, and hashed from its bytes. The client records the version (for example
// segmenter@1) on every call and in the idempotency key, so a new version is a new call. Editing a shipped version is
// refused by the test in load.test.ts, which pins each file's hash.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError } from "../contracts/errors.ts";
import { contentHash } from "../contracts/hash.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLE_NAME = /^[a-z][a-z_]{0,40}$/;

export type PromptRef = { role: string; version: number };

export type LoadedPrompt = {
  /** For example "segmenter@1". */
  id: string;
  role: string;
  version: number;
  /** The whole file: role and rules, reference material, task input description and output contract. */
  text: string;
  /** sha256 of the file bytes. */
  fileHash: string;
};

export function promptId(ref: PromptRef): string {
  return `${ref.role}@${ref.version}`;
}

/** Where the file of a prompt lives. Used by the loader and by the tests. */
export function promptPath(ref: PromptRef): string {
  checkRef(ref);
  return join(HERE, `${promptId(ref)}.md`);
}

function checkRef(ref: PromptRef): void {
  if (!ROLE_NAME.test(ref.role)) {
    throw new EngineError("invalid_input", `prompt role ${ref.role} must be a lower-case name`);
  }
  if (!Number.isInteger(ref.version) || ref.version < 1) {
    throw new EngineError("invalid_input", `prompt version of ${ref.role} must be an integer from 1`);
  }
}

const cache = new Map<string, LoadedPrompt>();

/**
 * Load a prompt version. The file's first line must be its own name ("# segmenter@1"), so a file copied under the wrong
 * version fails here rather than running as another version.
 */
export function loadPrompt(ref: PromptRef): LoadedPrompt {
  checkRef(ref);
  const id = promptId(ref);
  const cached = cache.get(id);
  if (cached) return cached;

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(promptPath(ref));
  } catch (error) {
    throw new EngineError("config", `prompt ${id} is missing from src/engine/prompts`, { cause: error });
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine !== `# ${id}`) {
    throw new EngineError("config", `prompt file for ${id} must start with "# ${id}"`);
  }

  const loaded: LoadedPrompt = {
    id,
    role: ref.role,
    version: ref.version,
    text,
    fileHash: contentHash(bytes),
  };
  cache.set(id, loaded);
  return loaded;
}
