// What a Claude role is: its capability, its prompt, its input and answer contracts, and the token estimate of one call
// (Bible 11.1). A role is data plus pure functions; the client (client.ts) does every call, budget step and retry.

import type { ClaudeRole } from "../contracts/index.ts";
import type { ZodType } from "zod";
import type { Capability } from "../config/routes.ts";
import type { ContentPart } from "../gateway/openrouter.ts";
import type { PromptRef } from "../prompts/load.ts";

/** The capabilities a Claude role can use (Bible 11.1: Opus for direction, Sonnet for analysis, Haiku for checks). */
export type ClaudeCapability = Extract<Capability, "llm.direction" | "llm.analysis" | "llm.check">;

export type RoleDefinition<Input, Answer> = {
  /** The role's name, for example "segmenter". Also the prompt's name. */
  role: ClaudeRole;
  capability: ClaudeCapability;
  /** The pipeline stage the role serves (Bible 6.x), used in error messages. */
  stage: string;
  prompt: PromptRef;
  /** The role's input contract. The client validates every input before it reserves anything. */
  input: ZodType<Input>;
  /** The answer contract, built from the input so that answers can be checked against it (for example, word ids). */
  answer: (input: Input) => ZodType<Answer>;
  /** The name sent with the JSON schema of the answer. */
  schemaName: string;
  /** The output cap. It equals the output tokens priced in the estimate, so the output cannot exceed what was reserved. */
  maxOutputTokens: number;
  /** The HTTP timeout of one call. It stays under the 2-minute lease of a Claude job (Bible 5.1). */
  timeoutMs: number;
  /** Tokens priced for one call (Bible 11.1, initial). The reconcile records what the call really cost. */
  estimateTokens: { input: number; output: number };
  /** One line of the rule that a failed check broke, sent with the single retry. Written by the role, never by the model. */
  retryRule: string;
  /** The user message content of one call: data blocks and images. */
  userContent: (input: Input) => string | ContentPart[];
};
