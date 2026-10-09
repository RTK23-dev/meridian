import { createHash } from "node:crypto";
import type { z } from "zod";

export class JevValidationError extends Error {
  readonly context: {
    questionVersion: string;
    schemaVersion: string;
    provider: string;
    model: string;
    issues?: z.ZodIssue[];
  };

  constructor(
    message: string,
    context: {
      questionVersion: string;
      schemaVersion: string;
      provider: string;
      model: string;
      issues?: z.ZodIssue[];
    }
  ) {
    super(message);
    this.name = "JevValidationError";
    this.context = context;
  }
}

export interface ValidatedJevResponse<T> {
  data: T;
  provenance: {
    questionVersion: string;
    schemaVersion: string;
    provider: string;
    model: string;
    inputHash: string;
    responseHash: string;
  };
}

/**
 * Validates a raw JEV model response:
 * 1. JSON syntax parsing
 * 2. Zod schema validation
 * 3. Hashing of input and response for cryptographic auditability
 */
export function validateJevModelResponse<T>(
  schema: z.ZodType<T>,
  rawResponse: string | unknown,
  context: {
    inputText?: string;
    questionVersion: string;
    schemaVersion: string;
    provider: string;
    model: string;
  }
): ValidatedJevResponse<T> {
  let parsed: unknown;

  const responseString = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
  const responseHash = createHash("sha256").update(responseString).digest("hex");
  const inputHash = createHash("sha256").update(context.inputText || "").digest("hex");

  if (typeof rawResponse === "string") {
    try {
      parsed = JSON.parse(rawResponse);
    } catch (err: any) {
      throw new JevValidationError(`Malformed JEV JSON syntax: ${err?.message}`, {
        questionVersion: context.questionVersion,
        schemaVersion: context.schemaVersion,
        provider: context.provider,
        model: context.model,
      });
    }
  } else {
    parsed = rawResponse;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new JevValidationError(
      `JEV response failed schema validation (${context.schemaVersion}): ${errorDetails}`,
      {
        questionVersion: context.questionVersion,
        schemaVersion: context.schemaVersion,
        provider: context.provider,
        model: context.model,
        issues: result.error.issues,
      }
    );
  }

  return {
    data: result.data,
    provenance: {
      questionVersion: context.questionVersion,
      schemaVersion: context.schemaVersion,
      provider: context.provider,
      model: context.model,
      inputHash,
      responseHash,
    },
  };
}
