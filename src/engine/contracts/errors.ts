// Typed engine errors (Bible 17.2 rule 5): every error has a kind, a retry flag and the stage it came from.
// Errors are never swallowed and never turned into a success return.

export const ENGINE_ERROR_KINDS = [
  "invalid_input",
  "not_found",
  "conflict",
  "unknown_price",
  "config",
  "provider",
  "internal",
  "not_implemented",
] as const;

export type EngineErrorKind = (typeof ENGINE_ERROR_KINDS)[number];

export type EngineErrorOptions = {
  retryable?: boolean;
  stage?: string;
  cause?: unknown;
};

export class EngineError extends Error {
  kind: EngineErrorKind;
  retryable: boolean;
  stage: string | undefined;

  constructor(kind: EngineErrorKind, message: string, options: EngineErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EngineError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.stage = options.stage;
  }
}
