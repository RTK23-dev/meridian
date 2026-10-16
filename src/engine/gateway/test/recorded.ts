// A recorded transport for the gateway tests: it answers from a queue and keeps every request it was given.

import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../types.ts";

export type Recorded = { transport: HttpTransport; requests: HttpRequest[] };

export function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

export function recorded(responses: HttpResponse[]): Recorded {
  const requests: HttpRequest[] = [];
  const queue = [...responses];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const next = queue.shift();
      if (!next) throw new Error(`no recorded response left for ${request.method} ${request.url}`);
      return next;
    },
  };
}

export function staticKeys(keys: Record<string, string>): CredentialSource {
  return {
    async get(credentialId): Promise<CredentialLookup> {
      const secret = keys[credentialId];
      return secret ? { status: "ready", credential: { kind: "api_key", secret } } : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
}
