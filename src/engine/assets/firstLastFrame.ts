// The first-and-last-frame test (Bible 20.3 item 2). Which OpenRouter video models accept both a first and a last frame is
// read from GET /videos/models (free, through the gateway). For the live run, one short test per model is submitted with both
// frames, under a reservation: a model that accepts the request passes the submit, and a model that rejects it fails.
//
// The results table feeds video.i2v_pinned. The lead updates config/routes.ts from the recorded result; this file never edits
// routes. A row passes only when the listing says both frames are supported, the duration and resolution the test needs are
// listed, and (in a live run) the submit was accepted. Without a live run the table says so: the basis is "listing_only".

import { assetCacheKey, type AssetSpec } from "../contracts/assets.ts";
import { newId } from "../contracts/ids.ts";
import type { LedgerStore } from "../budget/store.ts";
import { EngineError } from "../contracts/errors.ts";
import { paidCall, type PaidRun } from "../gateway/paid.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import { isDisabledModel } from "../config/model-policy.ts";
import { openRouterVideoAdapter, isVideoClass, listVideoModels, videoProfilesFromListing, VIDEO_ASPECT, VIDEO_RESOLUTION, type VideoProfile } from "./providers/openrouterVideo.ts";
import { classifyError } from "./classify.ts";

/** The classes whose OpenRouter models the test covers. The pinned class has no model of its own yet. */
export const FRAME_TEST_CLASSES = ["video.cinematic", "video.budget"] as const;

/** The reason a route's model is not tested: its family is switched off by the workspace's model policy (owner direction 2026-10-23). */
const SWITCHED_OFF = "switched off by the workspace's model policy";

/** Whether a route names a model of a family the workspace has switched off. */
function switchedOff(route: ResolvedRoute, families: readonly string[]): boolean {
  return route.model !== null && isDisabledModel(route.model, families);
}

/**
 * The workspace's switched-off families, which every decision of the table and the live test is made against. None is refused, before any
 * read or request: the built-in list is the initial policy, not this workspace's, so it is never a stand-in for the families a run passes (D16).
 */
function requiredFamilies(families: readonly string[] | undefined): readonly string[] {
  if (families === undefined) {
    throw new EngineError("invalid_input", "the workspace's switched-off model families must be passed; none were, so no route is decided or tested");
  }
  return families;
}

export const FRAME_TEST_PROMPT = "A single product on a plain table, a slow push-in. Frame test for Bible 20.3 item 2.";

export type SubmitOutcome = { kind: "not_run"; reason: string } | { kind: "accepted"; jobRef: string; estimateUsd: number } | { kind: "rejected"; reason: string } | { kind: "refused"; reason: string };

export type FrameTestRow = {
  model: string;
  modelClass: string;
  listed: boolean;
  firstFrame: boolean;
  lastFrame: boolean;
  durationListed: boolean;
  submit: SubmitOutcome;
  /** Both frames listed, the test's duration and resolution listed, and the submit accepted when a live submit was made. */
  pass: boolean;
  /** "listing_and_submit" for a live result, "listing_only" when no call was made. */
  basis: "listing_and_submit" | "listing_only";
};

/** The routed OpenRouter targets of the covered classes, each model once, in route priority order. */
export function videoRoutesForFrameTest(gateway: Gateway): ResolvedRoute[] {
  const seen = new Set<string>();
  const routes: ResolvedRoute[] = [];
  for (const capability of FRAME_TEST_CLASSES) {
    for (const route of gateway.routes(capability)) {
      if (route.provider.id !== "openrouter" || route.model === null || seen.has(route.model)) continue;
      seen.add(route.model);
      routes.push(route);
    }
  }
  return routes;
}

/** Why the test cannot run on a model's profile, or null when it can. A test that cannot run spends nothing. */
export function frameTestPrecheck(profile: VideoProfile | null, durationSeconds: number): string | null {
  if (profile === null) return "the model is not in GET /videos/models";
  if (!profile.capabilities.firstFrame || !profile.capabilities.lastFrame) {
    return "the listing does not show both a first and a last frame, so no test is sent";
  }
  if (!profile.durations.includes(durationSeconds)) return `the model does not list ${durationSeconds} seconds`;
  if (!profile.resolutions.includes(VIDEO_RESOLUTION)) return `the model does not list ${VIDEO_RESOLUTION}`;
  if (!profile.capabilities.aspect.includes(VIDEO_ASPECT)) return `the model does not list ${VIDEO_ASPECT}`;
  return null;
}

function rowFor(route: ResolvedRoute, profile: VideoProfile | null, durationSeconds: number, submit: SubmitOutcome): FrameTestRow {
  const model = route.model ?? "";
  const listed = profile !== null;
  const firstFrame = profile?.capabilities.firstFrame ?? false;
  const lastFrame = profile?.capabilities.lastFrame ?? false;
  const durationListed = profile?.durations.includes(durationSeconds) ?? false;
  const liveSubmit = submit.kind !== "not_run";
  const listingPasses = frameTestPrecheck(profile, durationSeconds) === null && firstFrame && lastFrame;
  return {
    model,
    modelClass: route.capability,
    listed,
    firstFrame,
    lastFrame,
    durationListed,
    submit,
    pass: listingPasses && (liveSubmit ? submit.kind === "accepted" : true),
    basis: liveSubmit ? "listing_and_submit" : "listing_only",
  };
}

/**
 * The table from a GET /videos/models answer alone. No call is made, so every row's basis is listing_only. A route whose model is in a
 * switched-off family does not pass: it is not tested, so the table cannot pin it. The families are the workspace's and are required.
 */
export function frameTestFromListing(listing: unknown, routes: ResolvedRoute[], durationSeconds: number, disabledFamilies: readonly string[]): FrameTestRow[] {
  const families = requiredFamilies(disabledFamilies);
  const { profiles } = videoProfilesFromListing(listing);
  return routes.map((route) => {
    const profile = route.model === null ? null : (profiles.get(route.model) ?? null);
    if (switchedOff(route, families)) return { ...rowFor(route, profile, durationSeconds, { kind: "not_run", reason: SWITCHED_OFF }), pass: false };
    const submit: SubmitOutcome = { kind: "not_run", reason: frameTestPrecheck(profile, durationSeconds) ?? "listing only; no submit" };
    return rowFor(route, profile, durationSeconds, submit);
  });
}

/** The first model that passes on a live submit, in route order. Null when none passes. This is the value for video.i2v_pinned. */
export function pinnedCandidate(rows: FrameTestRow[], options: { requireLive: boolean }): string | null {
  const row = rows.find((candidate) => candidate.pass && (!options.requireLive || candidate.basis === "listing_and_submit"));
  return row === undefined ? null : row.model;
}

/** A markdown table of the rows, for the owner's live-run record. */
export function renderFrameTable(rows: FrameTestRow[]): string {
  const header = "| model | class | listed | first frame | last frame | duration | submit | pass | basis |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const yes = (value: boolean) => (value ? "yes" : "no");
  const submit = (outcome: SubmitOutcome) => {
    if (outcome.kind === "not_run") return `not run (${outcome.reason})`;
    if (outcome.kind === "accepted") return `accepted, job ${outcome.jobRef}`;
    if (outcome.kind === "rejected") return `rejected (${outcome.reason})`;
    return `refused by budget (${outcome.reason})`;
  };
  const lines = rows.map(
    (row) =>
      `| ${row.model} | ${row.modelClass} | ${yes(row.listed)} | ${yes(row.firstFrame)} | ${yes(row.lastFrame)} | ${yes(row.durationListed)} | ${submit(row.submit)} | ${yes(row.pass)} | ${row.basis} |`,
  );
  return [header, divider, ...lines].join("\n");
}

type SubmitValue = { kind: "accepted"; jobRef: string } | { kind: "rejected"; reason: string };

export type FrameTestRun = {
  rows: FrameTestRow[];
  pinned: string | null;
  table: string;
  /** Entries of the listing the engine could not use, by id (never the provider's text). */
  listingRejected: Array<{ id: string | null; reason: string }>;
};

export type FrameTestInput = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  ledger: LedgerStore;
  /** A reservation the test submits can be held against. Each submit is held at its list estimate. */
  reservationId: string;
  frames: { first: string; last: string };
  durationSeconds: number;
  /** ISO time of the test. */
  at: string;
  /**
   * The workspace's switched-off model families (required). A family in this list is never submitted, and its row says why. A call that
   * passes none is refused before any request (D16).
   */
  disabledFamilies: readonly string[];
};

/**
 * The live test: lists the models, then submits one test per covered model with both frames. Each submit is a paid call under
 * the reservation and is keyed by its cache key. A model whose precheck fails is not submitted at all.
 */
export async function runFirstLastFrameTest(input: FrameTestInput): Promise<FrameTestRun> {
  // Refused before the listing is read: a run with no families is not a run of this workspace's policy.
  const families = requiredFamilies(input.disabledFamilies);
  const listing = await listVideoModels(input.gateway, input.organizationId);
  const parsed = videoProfilesFromListing(listing);
  const routes = videoRoutesForFrameTest(input.gateway);
  const rows: FrameTestRow[] = [];

  for (const route of routes) {
    const profile = route.model === null ? null : (parsed.profiles.get(route.model) ?? null);
    // A model of a switched-off family is not submitted, so the test spends nothing on it (owner direction 2026-10-23).
    if (switchedOff(route, families)) {
      rows.push({ ...rowFor(route, profile, input.durationSeconds, { kind: "not_run", reason: SWITCHED_OFF }), pass: false });
      continue;
    }
    const reason = frameTestPrecheck(profile, input.durationSeconds);
    if (profile === null || reason !== null || !isVideoClass(route.capability)) {
      rows.push(rowFor(route, profile, input.durationSeconds, { kind: "not_run", reason: reason ?? "not a video class" }));
      continue;
    }
    const adapter = openRouterVideoAdapter({ gateway: input.gateway, organizationId: input.organizationId, route, profile });
    const spec: AssetSpec = {
      schema: "meridian.asset_spec/v1",
      specId: newId("asp_"),
      modelChoice: null,
      shotId: newId("shot_"),
      modelClass: route.capability,
      prompt: FRAME_TEST_PROMPT,
      refs: [],
      firstFrame: input.frames.first,
      lastFrame: input.frames.last,
      durationMs: input.durationSeconds * 1000,
      aspect: "9:16",
      width: 1080,
      height: 1920,
      seed: 0,
      takes: 1,
    };
    const key = assetCacheKey(spec, adapter.id);
    const estimateUsd = adapter.price(spec).estimateUsd;

    const paid = await paidCall<SubmitValue>(
      { ledger: input.ledger, reservationId: input.reservationId, stage: "frame_test", route, estimateUsd, idempotencyKey: key, at: input.at },
      async (): Promise<PaidRun<SubmitValue>> => {
        try {
          const { jobRef } = await adapter.submit(spec, key);
          return { value: { kind: "accepted", jobRef }, actualUsd: null };
        } catch (error) {
          return { value: { kind: "rejected", reason: classifyError(error).message }, actualUsd: null };
        }
      },
    );
    if (paid.status === "refused") {
      rows.push(rowFor(route, profile, input.durationSeconds, { kind: "refused", reason: paid.reason }));
    } else if (paid.status === "duplicate") {
      rows.push(rowFor(route, profile, input.durationSeconds, { kind: "refused", reason: `already authorized as ${paid.entry.entryId}` }));
    } else if (paid.value.kind === "accepted") {
      rows.push(rowFor(route, profile, input.durationSeconds, { kind: "accepted", jobRef: paid.value.jobRef, estimateUsd }));
    } else {
      rows.push(rowFor(route, profile, input.durationSeconds, { kind: "rejected", reason: paid.value.reason }));
    }
  }

  return {
    rows,
    pinned: pinnedCandidate(rows, { requireLive: true }),
    table: renderFrameTable(rows),
    listingRejected: parsed.rejected,
  };
}
