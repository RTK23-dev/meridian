// Test helpers for the take gate: recorded HTTP answers, a credential source, a ledger with one reservation, a recorded
// similarity scorer, a shot, six frames and synthetic gold metrics. No helper calls a live API or reads a key from the
// environment. The recorded responses are authored in the OpenRouter shape (see fixtures/README.md).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { budgetReservationSchema, type BudgetReservation } from "../../contracts/index.ts";
import { createGateway, type Gateway } from "../../gateway/gateway.ts";
import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../../gateway/types.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { goldMetrics, type GoldMetrics } from "../gold.ts";
import type { SimilarityRequest, SimilarityScorer } from "../take/similarity.ts";
import type { SimilarityOutcome, SimilarityKind, TakeGoldKey, TakeShot } from "../take/types.ts";
import { TAKE_GOLD_KEYS } from "../take/types.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const NOW = "2026-10-14T10:01:00.000Z";
export const WORKSPACE = "ws_test";
export const REQUEST_ID = "req_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const RESERVATION_ID = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const SHOT_ID = "shot_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const TAKE_ID = "take_01JABCDEFGHJKMNPQRSTVWXYZ1";
export const TAKE_ID_2 = "take_01JABCDEFGHJKMNPQRSTVWXYZ2";

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name.endsWith(".json") ? name : `${name}.json`), "utf8");
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
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
  options: { keys?: Record<string, string> } = {},
): { gateway: Gateway; requests: HttpRequest[] } {
  const recorded = recordedTransport(responses);
  const gateway = createGateway({
    transport: recorded.transport,
    credentials: keySource(options.keys ?? { openrouter: "sk-or-test" }),
  });
  return { gateway, requests: recorded.requests };
}

export type LedgerOptions = { mode?: "cap" | "warn" | "observe"; paused?: boolean };

/** A ledger with one reservation for the test request, held at reservedUsd. */
export async function ledgerWith(reservedUsd: number, options: LedgerOptions = {}): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  const paused = options.paused === true;
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION_ID,
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE,
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

export function roleDeps(gateway: Gateway, ledger: LedgerStore): RoleDeps {
  return { gateway, ledger, now: () => NOW };
}

/** The request fields every critic call needs. */
export function criticRequestBase() {
  return { requestId: REQUEST_ID, workspaceId: WORKSPACE, reservationId: RESERVATION_ID };
}

/** A 1x1 PNG as a data URL. Real frames are larger; the tests need only a well formed image. */
export const FRAME_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Six frames of a 4100 ms take, in time order, all inside the take. Each take is a different clip, so a different shift
 * gives it different frame times: the Critic's key is the hash of its input, and two takes with the same input are one call.
 */
export function takeFrames(shiftMs = 0): Array<{ atMs: number; imageUrl: string }> {
  return [500, 1200, 1900, 2600, 3300, 4000].map((atMs) => ({ atMs: atMs + shiftMs, imageUrl: FRAME_IMAGE_URL }));
}

export const TAKE_DURATION_MS = 4100;

/** A product shot: a hero image, no persona. The palette check always applies. */
export function productShot(overrides: Partial<TakeShot> = {}): TakeShot {
  return {
    shotId: SHOT_ID,
    visualType: "product_hero",
    plannedDurationMs: 4000,
    motionRequired: true,
    product: { heroUris: ["asset://product/hero-1"] },
    persona: null,
    ...overrides,
  };
}

/** A presenter shot: a persona portrait and no product. */
export function presenterShot(overrides: Partial<TakeShot> = {}): TakeShot {
  return {
    shotId: SHOT_ID,
    visualType: "ugc_presenter",
    plannedDurationMs: 4000,
    motionRequired: true,
    product: null,
    persona: { portraitUris: ["asset://persona/portrait-1"] },
    ...overrides,
  };
}

export const PALETTE = ["#1a2b3c", "#ffffff", "#f5a623"];

type ScoreTable = Partial<Record<SimilarityKind, number>>;

/** A similarity scorer that answers from a recorded table and keeps every request it was sent. */
export function recordedScorer(scores: ScoreTable, id = "similarity:recorded"): SimilarityScorer & { requests: SimilarityRequest[] } {
  const requests: SimilarityRequest[] = [];
  return {
    id,
    requests,
    async score(request: SimilarityRequest): Promise<SimilarityOutcome> {
      requests.push(request);
      const score = scores[request.kind];
      if (score === undefined) return { status: "not_connected", reason: `no recorded score for ${request.kind}` };
      return { status: "scored", score, scorer: id };
    },
  };
}

/** A recorded similarity table as the fixture stores it: the clean take, or the one with the warped product. */
export function recordedScores(name: "clean" | "warped_product"): ScoreTable {
  return fixture<Record<string, ScoreTable>>("similarity-scores")[name] ?? {};
}

/** Gold metrics that meet the target (12.4): 200 labels, 100 failing (90 caught) and 100 passing (10 false fails). */
export function provenMetrics(): GoldMetrics {
  const outcomes = [
    ...Array.from({ length: 100 }, (_, index) => ({ shouldFail: true, predictedFail: index < 90 })),
    ...Array.from({ length: 100 }, (_, index) => ({ shouldFail: false, predictedFail: index < 10 })),
  ];
  return goldMetrics(outcomes);
}

/** Gold metrics on too few labels to block: the same rates on 20 labels. */
export function unprovenMetrics(): GoldMetrics {
  const outcomes = [
    ...Array.from({ length: 10 }, (_, index) => ({ shouldFail: true, predictedFail: index < 9 })),
    ...Array.from({ length: 10 }, (_, index) => ({ shouldFail: false, predictedFail: index < 1 })),
  ];
  return goldMetrics(outcomes);
}

/** A metrics table in which every take gold key meets the target. */
export function everyKeyProven(): Partial<Record<TakeGoldKey, GoldMetrics>> {
  const proven = provenMetrics();
  return Object.fromEntries(TAKE_GOLD_KEYS.map((key) => [key, proven])) as Partial<Record<TakeGoldKey, GoldMetrics>>;
}

export { TAKE_GOLD_KEYS };
