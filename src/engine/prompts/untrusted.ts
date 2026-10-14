// Untrusted data in a prompt (CLAUDE.md rule 8; Bible 11.2 part 3). Transcripts, on-screen text and fetched material are
// data for the model to read, never instructions. Each value is JSON-encoded, and the characters <, > and & are written as
// JSON unicode escapes, so no value can contain a closing tag and end its own block early.

import { EngineError } from "../contracts/errors.ts";

const BLOCK_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const ESCAPED: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

/** A named block of untrusted data, ready to put in a user message. The name is ours, never the data's. */
export function untrustedBlock(name: string, value: unknown): string {
  if (!BLOCK_NAME.test(name)) {
    throw new EngineError("invalid_input", `untrusted block name ${name} must be a lower-case identifier`);
  }
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new EngineError("invalid_input", `untrusted block ${name} needs a JSON value`);
  }
  const escaped = json.replace(/[<>&]/g, (character) => ESCAPED[character] ?? character);
  return `<untrusted-data name="${name}">\n${escaped}\n</untrusted-data>`;
}
