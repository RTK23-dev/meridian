const SECRET = /access_token|refresh_token|client_secret|authorization/i;

export function redactSecrets(value: string): string {
  return value
    .replace(/access_token=[^&\s]+/gi, "access_token=redacted")
    .replace(/refresh_token=[^&\s]+/gi, "refresh_token=redacted")
    .replace(/client_secret=[^&\s]+/gi, "client_secret=redacted")
    .replace(/Bearer\s+\S+/gi, "Bearer redacted")
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"redacted"')
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"redacted"');
}

export function operationRecord(input: {
  correlationId: string;
  provider: string;
  operation: string;
  organizationId: string;
  brandId: string;
  durationMs: number;
  ok: boolean;
  attempts: number;
  detail: string;
}): Record<string, string | number | boolean> {
  const detail = redactSecrets(input.detail);
  if (SECRET.test(detail) && !detail.includes("redacted")) {
    return { ...input, detail: "A provider detail was removed because it looked like a secret." };
  }
  return { ...input, detail };
}

export function startOperation(input: { provider: string; operation: string; organizationId: string; brandId: string }): {
  correlationId: string;
  finish: (ok: boolean, attempts: number, detail: string) => Record<string, string | number | boolean>;
} {
  const correlationId = crypto.randomUUID();
  const started = Date.now();
  return {
    correlationId,
    finish(ok, attempts, detail) {
      return operationRecord({
        correlationId,
        provider: input.provider,
        operation: input.operation,
        organizationId: input.organizationId,
        brandId: input.brandId,
        durationMs: Date.now() - started,
        ok,
        attempts,
        detail,
      });
    },
  };
}
