// Test helpers for the asset router and adapters: a scripted transport that answers from recorded replies and fails on any
// request it was not told about, a fake clock, a budget reservation, and a valid AssetSpec. No test in this folder calls a
// live API; the transport is the only network, and it is replaced here.

import { readFileSync } from "node:fs";
import { budgetReservationSchema, newId, type AssetSpec, type BudgetReservation } from "../../contracts/index.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { createGateway, type Gateway } from "../../gateway/gateway.ts";
import type { Capability, RouteTable, RouteTarget } from "../../config/routes.ts";
import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../../gateway/types.ts";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

export function raw(status: number, body: Uint8Array, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body };
}

/** One reply: a response, an error thrown by the transport, or a function of the request. */
export type Reply = HttpResponse | Error | ((request: HttpRequest) => HttpResponse);

export type Scripted = { transport: HttpTransport; requests: HttpRequest[] };

/**
 * A transport that answers by "METHOD pathname" (the query is ignored). Each key has a list of replies used in order; the last
 * reply repeats. A request with no key throws, so a test fails if the code calls a provider it was not meant to call.
 */
export function scripted(script: Record<string, Reply | Reply[]>): Scripted {
  const queues = new Map<string, Reply[]>(
    Object.entries(script).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) throw new Error(`unexpected request: ${key}`);
    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(request) : reply;
  };
  return { transport, requests };
}

export function staticKeys(keys: Record<string, string>): CredentialSource {
  return {
    async get(credentialId): Promise<CredentialLookup> {
      const secret = keys[credentialId];
      return secret ? { status: "ready", credential: { kind: "api_key", secret } } : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
}

export const KEYS = { openrouter: "sk-or-test", pexels: "pexels-test", pixabay: "pixabay-test" };

export function gatewayFor(transport: HttpTransport, options: { keys?: Record<string, string>; routes?: RouteTable } = {}): Gateway {
  return createGateway({ transport, credentials: staticKeys(options.keys ?? KEYS), ...(options.routes ? { routes: options.routes } : {}) });
}

export const ORG = "org_1";
export const WORKSPACE = "org_1";
export const START_MS = Date.UTC(2026, 9, 14, 10, 0, 0);

/** A clock that moves only when the router sleeps or a test advances it. */
export function fakeClock(startMs: number = START_MS) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A ledger with one reservation of `usd`, in the given mode. Cap mode refuses a call the reservation cannot cover. */
export async function ledgerWithReservation(usd: number, mode: "cap" | "warn" = "cap"): Promise<{ ledger: LedgerStore; reservationId: string }> {
  const ledger = memoryLedgerStore();
  const reservationId = newId("res_");
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId,
    requestId: newId("req_"),
    workspaceId: WORKSPACE,
    mode,
    lines: [{ stage: "produce_shot", estimateUsd: usd }],
    estimateUsd: usd,
    redoAllowanceUsd: 0,
    reservedUsd: usd,
    state: "reserved",
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await ledger.createReservation(reservation);
  return { ledger, reservationId };
}

/** A valid AssetSpec. The prompt is distinct per call unless given, so cache keys differ between tests. */
export function assetSpec(overrides: Partial<AssetSpec> = {}): AssetSpec {
  return {
    schema: "meridian.asset_spec/v1",
    specId: newId("asp_"),
    modelChoice: null,
    shotId: newId("shot_"),
    modelClass: "video.cinematic",
    prompt: "A ceramic mug on a wooden table, steam rising, slow push-in.",
    refs: [],
    durationMs: 5000,
    aspect: "9:16",
    width: 1080,
    height: 1920,
    seed: 7,
    takes: 1,
    ...overrides,
  };
}

/** A route table with the given targets for one capability, on top of a base table. */
export function routesWith(capability: Capability, targets: RouteTarget[], base: RouteTable): RouteTable {
  return { ...base, [capability]: { targets } };
}

/** A minimal PNG: the signature and padding, above the 1 KiB floor. */
export function pngBytes(size = 1100): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/** An MP3 stream that starts with an ID3 tag, above the speech floor. */
export function mp3Bytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0);
  return bytes;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
