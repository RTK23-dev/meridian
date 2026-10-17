// Test helpers for the plan stage: the contracts fixtures as plan inputs, the recorded role answers, and a ledger holding one
// reservation for the fixture request. No helper calls a live API; the gateway answers from the recorded queue.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayFor, json } from "../../claude/test/helpers.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { budgetReservationSchema, type ProductionRequest, type ValidatedRequest } from "../../contracts/index.ts";
import {
  FIXTURE_IDS,
  characterSheetFixture,
  personaFixture,
  productKitFixture,
  productionRequestFixture,
  styleKitFixture,
  validatedRequestFixture,
  videoDnaFixture,
  voiceTrackFixture,
} from "../../contracts/fixtures/index.ts";
import { WORKSPACE_ID } from "../../contracts/fixtures/chain.ts";
import type { HttpResponse } from "../../gateway/types.ts";
import type { PlanSceneInput, PlanKitBodies } from "../build.ts";
import type { VisualClassification } from "../../review/gates/request.ts";
import { scriptOf } from "../../script/resolve.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const NOW = "2026-10-14T10:01:00.000Z";
export const BLENDER = "the blender on a clean kitchen counter";

/** The script's words, as the fixture voice speaks them. The planner and director inputs must never contain them. */
export const SCRIPT_WORDS = ["lying to you", "clears it twice", "one blender", "four smoothies", "Send BLEND"];

/** One recorded answer file: the OpenRouter envelope, as the gateway receives it. */
export function recordedAnswer(name: string): HttpResponse {
  return json(200, JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as unknown);
}

/** The request with its budget replaced (the fixture's own budget is $4). */
export function requestWithBudget(budgetUsd: number): ProductionRequest {
  return { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd } };
}

/** The validated request that names the fixture request with the given budget. */
export function validatedWithBudget(budgetUsd: number): ValidatedRequest {
  return { ...validatedRequestFixture, request: requestWithBudget(budgetUsd) };
}

/** The kit bodies the fixture request names, as intake's kit store returns them. */
export function fixtureKitBodies(): PlanKitBodies {
  return {
    styleKit: structuredClone(styleKitFixture),
    persona: structuredClone(personaFixture),
    productKit: structuredClone(productKitFixture),
    characters: [structuredClone(characterSheetFixture)],
  };
}

/** The fixture's classification: the one must is real_product. */
export function fixtureClassifications(): VisualClassification[] {
  return [{ beatId: "b3", want: BLENDER, properties: ["real_product"] }];
}

/** A ledger with one reservation for the fixture request, in the fixture workspace. */
export async function ledgerFor(reservedUsd: number): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: FIXTURE_IDS.reservation,
    requestId: FIXTURE_IDS.request,
    workspaceId: WORKSPACE_ID,
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: reservedUsd }],
    estimateUsd: reservedUsd,
    redoAllowanceUsd: 0,
    reservedUsd,
    state: "reserved",
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await ledger.createReservation(reservation);
  return ledger;
}

/**
 * The Claude deps for the fixture request: the recorded gateway answers in order, and a ledger that holds `reservedUsd`. The
 * returned requests array is the transport's record of every call.
 */
export async function depsWith(responses: HttpResponse[], reservedUsd: number): Promise<{ deps: RoleDeps; requests: { body?: string | Uint8Array; url: string }[] }> {
  const { gateway, requests } = gatewayFor(responses);
  const ledger = await ledgerFor(reservedUsd);
  return { deps: { gateway, ledger, now: () => NOW }, requests };
}

/** The plan input for the fixture request at a budget. The answers come from the recorded queue in `responses`. */
export async function planInputWith(
  responses: HttpResponse[],
  options: { budgetUsd?: number; reservedUsd?: number; classifications?: VisualClassification[] } = {},
): Promise<{ input: PlanSceneInput; requests: { body?: string | Uint8Array; url: string }[] }> {
  const budgetUsd = options.budgetUsd ?? 4;
  const { deps, requests } = await depsWith(responses, options.reservedUsd ?? 4);
  const validated = validatedWithBudget(budgetUsd);
  return {
    requests,
    input: {
      requestId: FIXTURE_IDS.request,
      workspaceId: WORKSPACE_ID,
      reservationId: FIXTURE_IDS.reservation,
      attempt: 1,
      request: validated.request,
      script: scriptOf(validated.request, null),
      validated,
      voice: structuredClone(voiceTrackFixture),
      dna: structuredClone(videoDnaFixture),
      kits: fixtureKitBodies(),
      classifications: options.classifications ?? fixtureClassifications(),
      deps,
    },
  };
}

/** The text of every user message a recorded request sent, concatenated (the untrusted blocks included). */
export function sentText(body: string | Uint8Array | undefined): string {
  const parsed = JSON.parse(String(body)) as { messages: Array<{ role: string; content: unknown }> };
  return parsed.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: { text?: string }) => part.text ?? "").join("\n")
          : "",
    )
    .join("\n");
}
