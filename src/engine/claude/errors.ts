// The typed error of a role whose answer failed its contract twice (Bible 11: one retry on a StructuredOutputError, then the
// stage fails). It is a provider-side kind that is not retryable: the same input would fail the same way, so the job does
// not retry it. The issues are paths and codes only, never the model's text.

import { EngineError } from "../contracts/errors.ts";

export class RoleAnswerError extends EngineError {
  role: string;
  attempts: number;
  issues: string[];

  constructor(role: string, attempts: number, issues: string[], stage: string) {
    super("provider", `the ${role} answer did not match its contract after ${attempts} attempts: ${issues.join("; ")}`, {
      retryable: false,
      stage,
    });
    this.role = role;
    this.attempts = attempts;
    this.issues = issues;
  }
}
