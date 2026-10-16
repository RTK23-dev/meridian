// Test helpers for the Claude client: a recorded transport (answers from a queue, keeps every request), recorded fixtures,
// a credential source, and a ledger with one reservation. No test helper calls a live API.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { budgetReservationSchema, type BudgetReservation } from "../../contracts/index.ts";
import { routes, type RouteTable } from "../../config/routes.ts";
import { createGateway, type Gateway } from "../../gateway/gateway.ts";
import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../../gateway/types.ts";
import type { RoleDeps, RoleRequest } from "../client.ts";
import { segmenterInputSchema, type SegmenterInput } from "../roles/segmenter.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const NOW = "2026-10-14T10:01:00.000Z";
export const WORKSPACE = "ws_test";
export const REQUEST_ID = "req_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const RESERVATION_ID = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), "utf8");
}

export function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

export function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

/** A recorded transport: it answers from the queue in order and keeps every request. It throws when the queue is empty. */
export function recordedTransport(responses: HttpResponse[]): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const queue = [...responses];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const next = queue.shift();
    if (!next) throw new Error(`no recorded response left for ${request.method} ${request.url}`);
    return next;
  };
  return { transport, requests };
}

export function keySource(keys: Record<string, string>): CredentialSource {
  return {
    async get(credentialId): Promise<CredentialLookup> {
      const secret = keys[credentialId];
      return secret ? { status: "ready", credential: { kind: "api_key", secret } } : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
}

export function gatewayFor(
  responses: HttpResponse[],
  options: { keys?: Record<string, string>; routes?: RouteTable } = {},
): { gateway: Gateway; requests: HttpRequest[] } {
  const recorded = recordedTransport(responses);
  const gateway = createGateway({
    transport: recorded.transport,
    credentials: keySource(options.keys ?? { openrouter: "sk-or-test" }),
    routes: options.routes,
  });
  return { gateway, requests: recorded.requests };
}

/** The default route table with the analysis capability replaced. Used to test a model that has no rate. */
export function routesWithAnalysis(model: string): RouteTable {
  return {
    ...routes.table,
    "llm.analysis": { targets: [{ provider: "openrouter", model, priceKey: null, verified: false }] },
  } as RouteTable;
}

export type LedgerOptions = { mode?: "cap" | "warn" | "observe"; state?: "reserved" | "paused"; workspaceId?: string };

/** A ledger with one reservation for the test request, held at reservedUsd. */
export async function ledgerWith(reservedUsd: number, options: LedgerOptions = {}): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  const paused = options.state === "paused";
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION_ID,
    requestId: REQUEST_ID,
    workspaceId: options.workspaceId ?? WORKSPACE,
    mode: options.mode ?? "cap",
    lines: [{ stage: "claude_roles", estimateUsd: reservedUsd }],
    estimateUsd: reservedUsd,
    redoAllowanceUsd: 0,
    reservedUsd,
    state: paused ? "paused" : "reserved",
    ...(paused ? { pausedReason: "the test paused this reservation" } : {}),
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await ledger.createReservation(reservation);
  return ledger;
}

export function deps(gateway: Gateway, ledger: LedgerStore): RoleDeps {
  return { gateway, ledger, now: () => NOW };
}

export function segmenterInput(): SegmenterInput {
  return segmenterInputSchema.parse(fixture("segmenter-input"));
}

export function request<Input>(input: Input, extra: Partial<RoleRequest<Input>> = {}): RoleRequest<Input> {
  return {
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE,
    reservationId: RESERVATION_ID,
    input,
    ...extra,
  };
}

/** The user content of a recorded request, parsed back from the request body. */
export function sentMessages(body: string | Uint8Array | undefined): Array<{ role: string; content: unknown }> {
  const parsed = JSON.parse(String(body)) as { messages: Array<{ role: string; content: unknown }> };
  return parsed.messages;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text) : ""))
    .join("\n");
}
