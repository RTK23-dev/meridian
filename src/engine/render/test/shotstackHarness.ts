// Shared fixtures for the Shotstack tests: a component-free EDL, a component EDL, the fetchable URLs, and a scripted
// gateway. The responses are constructed from the documented shapes in docs/engine/PROVIDER_APIS.md ("Shotstack"). They
// are not captured from the live API: the owner's live run records real ones (render/STATUS.md).
//
// The scripted transport sits underneath the real gateway, so the tests see what the gateway sends: the x-api-key header
// on requests to the provider host and none on the download URL. Mismatches are collected in `problems`, not thrown,
// because the adapter wraps transport throws into provider errors and a thrown assertion would be hidden there.

import { type EditDecisionList, type GateResult } from "../../contracts/index.ts";
import { FIXTURE_IDS, scenePlanFixture, WORKSPACE_ID } from "../../contracts/fixtures/index.ts";
import { reserve } from "../../budget/reserve.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { createGateway, type Gateway } from "../../gateway/gateway.ts";
import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../../gateway/types.ts";
import {
  createShotstackAdapter,
  SHOTSTACK_BASE_URL,
  shotstackRenderKey,
  toShotstackTimeline,
  type ShotstackDeps,
  type ShotstackRenderBody,
} from "../shotstack.ts";

export const ORG = "org_fixture";
export const SHOTSTACK_KEY = "ss-test-key-not-a-real-credential";
export const SS_RENDER_ID = "ss_fixture_render_0001";
export const DOWNLOAD_URL = "https://ss-output.example.test/ss_fixture_render_0001.mp4?X-Amz-Signature=fixture";
export const VIDEO_BYTES = new TextEncoder().encode("fixture mp4 bytes, not a real video");

/** A component-free EDL: media (video and image), audio (voice, music, two overlapping sound effects) and plain text. */
export const componentFreeEdl: EditDecisionList = {
  schema: "meridian.edl/v1",
  edlId: FIXTURE_IDS.edl,
  requestId: FIXTURE_IDS.request,
  durationMs: 24000,
  fps: 30,
  width: 1080,
  height: 1920,
  tracks: [
    {
      layer: "base",
      clips: [
        { clipId: "c_base_1", startMs: 0, endMs: 9000, srcUri: "store://takes/base-1.mp4", srcInMs: 500, transitionIn: "hard" },
        { clipId: "c_base_2", startMs: 9000, endMs: 15000, srcUri: "store://takes/base-2.mp4", srcInMs: 0 },
      ],
    },
    { layer: "cutaway", clips: [{ clipId: "c_cut_1", startMs: 9000, endMs: 12000, srcUri: "store://takes/cutaway-1.png" }] },
    {
      layer: "presenter",
      clips: [
        {
          clipId: "c_pres_1",
          startMs: 0,
          endMs: 6000,
          srcUri: "store://takes/presenter-1.webm",
          srcInMs: 0,
          box: { x: 60, y: 900, w: 960, h: 700 },
        },
      ],
    },
    {
      layer: "captions",
      clips: [
        { clipId: "c_cap_1", startMs: 0, endMs: 3000, props: { text: "Send BLEND today" } },
        { clipId: "c_cap_2", startMs: 3000, endMs: 6000, props: { text: "to get the link" } },
      ],
    },
    { layer: "graphics", clips: [{ clipId: "c_gfx_1", startMs: 21000, endMs: 24000, props: { text: "Fixture Blender" } }] },
    { layer: "stickers", clips: [] },
  ],
  audio: {
    voice: { uri: "store://voice/fixture-voice.wav", startMs: 0, endMs: 24000, gainDb: 0 },
    music: { uri: "store://music/fixture-bed.wav", startMs: 0, endMs: 24000, gainDb: -12, duckDb: -18 },
    sfx: [
      { uri: "store://sfx/whoosh.wav", startMs: 8950, endMs: 9600, gainDb: -6 },
      { uri: "store://sfx/whoosh.wav", startMs: 9000, endMs: 9300, gainDb: -6 },
    ],
    masterLufs: -14,
  },
  effects: [{ atMs: 1200, kind: "punch_in", params: { scale: 1.1 } }],
  seed: 421337,
};

/** The same EDL with one custom component (a captions track that uses captions.karaoke). Shotstack must refuse it. */
export const componentEdl: EditDecisionList = {
  ...componentFreeEdl,
  tracks: [
    ...componentFreeEdl.tracks,
    { layer: "captions", clips: [{ clipId: "c_cap_karaoke", startMs: 0, endMs: 24000, component: "captions.karaoke", props: {} }] },
  ],
};

/** A fetchable URL for an EDL URI. The query stands in for a signed, temporary URL. */
export function fixtureSourceUrl(uri: string): string {
  return `https://media.example.test/fixture/${uri.replace(/[^a-z0-9.]+/gi, "-")}?X-Amz-Signature=fixture`;
}

/** The POST /render body for the component-free EDL, with the fixture URLs. */
export function expectedBody(sourceUrl: (uri: string) => string = fixtureSourceUrl): ShotstackRenderBody {
  const { timeline, output } = toShotstackTimeline(componentFreeEdl, sourceUrl);
  return { timeline, output };
}

export const EXPECTED_KEY = shotstackRenderKey(componentFreeEdl);

export type Exchange = {
  method: "GET" | "POST";
  url: string;
  status: number;
  /** A JSON body for the response. */
  json?: unknown;
  /** A raw body for the response (the download). */
  bytes?: Uint8Array;
  /** Header names that must be present; a leading "!" means absent. */
  headers?: string[];
  /** Header values that must match exactly. */
  values?: Record<string, string>;
  /** A JSON request body that must match exactly. */
  bodyJson?: unknown;
};

export function submitExchange(options: { key?: string; body?: unknown; status?: number } = {}): Exchange {
  return {
    method: "POST",
    url: `${SHOTSTACK_BASE_URL}/render`,
    status: options.status ?? 201,
    json: { success: true, message: "Created", response: { message: "Render Successfully Queued", id: SS_RENDER_ID } },
    headers: ["x-api-key", "Idempotency-Key", "content-type"],
    values: { "Idempotency-Key": options.key ?? EXPECTED_KEY },
    ...(options.body === undefined ? {} : { bodyJson: options.body }),
  };
}

export function pollExchange(status: string, extra: Record<string, unknown> = {}): Exchange {
  return {
    method: "GET",
    url: `${SHOTSTACK_BASE_URL}/render/${SS_RENDER_ID}`,
    status: 200,
    json: {
      success: true,
      message: "Render Found",
      response: { id: SS_RENDER_ID, status, error: null, duration: null, renderTime: null, url: null, ...extra },
    },
    headers: ["x-api-key"],
  };
}

export function downloadExchange(url = DOWNLOAD_URL): Exchange {
  return { method: "GET", url, status: 200, bytes: VIDEO_BYTES, headers: ["!x-api-key", "!Idempotency-Key"] };
}

export function errorExchange(method: "GET" | "POST", url: string, status: number, message: string): Exchange {
  return { method, url, status, json: { success: false, message } };
}

export type ScriptedGateway = {
  gateway: Gateway;
  /** Every request the transport received, as the gateway sent it. */
  seen: HttpRequest[];
  /** Mismatches between the requests and the script. Each test asserts this is empty. */
  problems: string[];
  /** Exchanges the script still expects. */
  remaining: () => number;
};

function header(request: HttpRequest, name: string): string | undefined {
  const key = Object.keys(request.headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : request.headers[key];
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A credential source that holds the given keys, as the gateway's credential resolver does. */
export function credentialsFor(keys: Record<string, string>): CredentialSource {
  return {
    async get(credentialId): Promise<CredentialLookup> {
      const secret = keys[credentialId];
      return secret
        ? { status: "ready", credential: { kind: "api_key", secret } }
        : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
}

/** A gateway over a scripted transport. The script plays in order; each request is checked against its exchange. */
export function scriptedGateway(exchanges: Exchange[], keys: Record<string, string> = { shotstack: SHOTSTACK_KEY }): ScriptedGateway {
  const seen: HttpRequest[] = [];
  const problems: string[] = [];
  let index = 0;
  const transport: HttpTransport = async (request): Promise<HttpResponse> => {
    seen.push(request);
    const expected = exchanges[index];
    index += 1;
    if (!expected) {
      problems.push(`unexpected request ${request.method} ${request.url}`);
      return { status: 599, headers: {}, body: new Uint8Array(0) };
    }
    if (request.method !== expected.method || request.url !== expected.url) {
      problems.push(`expected ${expected.method} ${expected.url}, got ${request.method} ${request.url}`);
    }
    for (const rule of expected.headers ?? []) {
      const absent = rule.startsWith("!");
      const name = absent ? rule.slice(1) : rule;
      const found = header(request, name);
      if (absent && found !== undefined) problems.push(`${name} must not be sent to ${request.url}`);
      if (!absent && found === undefined) problems.push(`${name} must be sent to ${request.url}`);
    }
    for (const [name, value] of Object.entries(expected.values ?? {})) {
      if (header(request, name) !== value) problems.push(`${name} on ${request.url} is not ${value}`);
    }
    if (expected.bodyJson !== undefined) {
      const body = typeof request.body === "string" ? JSON.parse(request.body) : undefined;
      if (JSON.stringify(body) !== JSON.stringify(expected.bodyJson)) problems.push(`the body of ${request.method} ${request.url} is not the expected body`);
    }
    if (expected.bytes !== undefined) return { status: expected.status, headers: {}, body: expected.bytes };
    return {
      status: expected.status,
      headers: { "content-type": "application/json" },
      body: expected.json === undefined ? new Uint8Array(0) : jsonBytes(expected.json),
    };
  };
  const gateway = createGateway({ transport, credentials: credentialsFor(keys) });
  return { gateway, seen, problems, remaining: () => exchanges.length - index };
}

/** The Shotstack adapter and deps, wired the way production wires them: the gateway's transport and connection. */
export function shotstackDepsFor(gateway: Gateway, ledger: LedgerStore, overrides: Partial<ShotstackDeps> = {}): ShotstackDeps & { stored: string[] } {
  const stored: string[] = [];
  const adapter = createShotstackAdapter({
    transport: gateway.transportFor("shotstack", ORG),
    connection: () => gateway.connection("shotstack", ORG),
    baseUrl: gateway.baseUrlFor("shotstack"),
  });
  return {
    adapter,
    ledger,
    resolveSourceUrl: async (uri) => fixtureSourceUrl(uri),
    verifyIntegrity: async (input) => passingGate(input.videoId),
    storeVideo: async ({ videoId }) => {
      stored.push(videoId);
      return `store://renders/${videoId}.mp4`;
    },
    pollIntervalMs: 0,
    sleep: async () => undefined,
    newVideoId: () => FIXTURE_IDS.video,
    stored,
    ...overrides,
  };
}

export function passingGate(videoId: string): GateResult {
  return {
    gate: "render_integrity",
    subjectId: videoId,
    pass: true,
    checks: [
      { rule: "resolution_1080x1920", pass: true },
      { rule: "fps_30", pass: true },
      { rule: "duration_within_100ms", pass: true, value: 24000, limit: 24100 },
      { rule: "audio_present", pass: true },
    ],
  };
}

/** A ledger with one reservation, as the budget stage makes it. */
export async function reservedLedger(requestBudgetUsd = 4): Promise<{ ledger: LedgerStore; reservationId: string }> {
  const ledger = memoryLedgerStore();
  const result = await reserve(ledger, {
    requestId: FIXTURE_IDS.request,
    workspaceId: WORKSPACE_ID,
    mode: "cap",
    plan: scenePlanFixture,
    requestBudgetUsd,
    workspaceMonthBudgetUsd: 100,
    now: "2026-10-13T09:00:00.000Z",
    reservationId: FIXTURE_IDS.reservation,
  });
  return { ledger, reservationId: result.reservation.reservationId };
}
