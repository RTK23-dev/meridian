import type { Transport } from "../providers/http.ts";
import {
  collectHypitArtifact,
  hypitConnection,
  pollHypitJob,
  startHypitJob,
} from "../hypit/client.ts";
import type { HypitJobContract } from "../hypit/contract.ts";
import { videoGenerationStatus } from "./provider.ts";

export type VideoEngineStatus =
  | { status: "NOT_CONNECTED"; provider: string; detail: string }
  | { status: "CONFIGURED"; provider: string; detail: string };

export type VideoEngine = {
  id: string;
  status(): VideoEngineStatus;
  submit: typeof startHypitJob extends (...args: infer _A) => infer R
    ? (contract: HypitJobContract, transport: Transport) => R
    : never;
  poll: typeof pollHypitJob extends (...args: infer _A) => infer R
    ? (providerJobId: string, transport: Transport) => R
    : never;
  collect: typeof collectHypitArtifact extends (...args: infer _A) => infer R
    ? (providerJobId: string, transport: Transport) => R
    : never;
};

export function hypitVideoEngine(): VideoEngine {
  return {
    id: "hypit",
    status() {
      const snapshot = videoGenerationStatus({ baseUrl: process.env.HYPIT_BASE_URL });
      return snapshot.status === "CONFIGURED"
        ? { status: "CONFIGURED", provider: "hypit", detail: snapshot.detail }
        : { status: "NOT_CONNECTED", provider: "hypit", detail: snapshot.detail };
    },
    submit(contract, transport) {
      const connection = hypitConnection();
      if (connection.status !== "CONFIGURED") {
        return Promise.resolve({ ok: false as const, code: "HYPIT_FAILED" as const, error: connection.detail });
      }
      return startHypitJob(connection, contract, transport);
    },
    poll(providerJobId, transport) {
      const connection = hypitConnection();
      if (connection.status !== "CONFIGURED") {
        return Promise.resolve({ ok: false as const, code: "HYPIT_FAILED" as const, error: connection.detail });
      }
      return pollHypitJob(connection, providerJobId, transport);
    },
    collect(providerJobId, transport) {
      const connection = hypitConnection();
      if (connection.status !== "CONFIGURED") {
        return Promise.resolve({ ok: false as const, code: "HYPIT_FAILED" as const, error: connection.detail });
      }
      return collectHypitArtifact(connection, providerJobId, transport);
    },
  };
}

/**
 * Timeline Fixture Provider:
 * Generates synthetic test clip fixtures for automated test suites.
 * Explicitly labeled as a test fixture to ensure it is never confused with a production renderer.
 */
export function timelineFixtureProvider(): VideoEngine {
  return {
    id: "timeline",
    status() {
      return {
        status: "CONFIGURED",
        provider: "timeline",
        detail: "Timeline test fixture provider for unit/integration testing only. Produces synthetic test clips.",
      };
    },
    async submit(contract) {
      return {
        ok: true,
        job: {
          providerJobId: `timeline_${contract.meridianJobId}`,
          status: "queued",
          error: "",
        },
      };
    },
    async poll(providerJobId) {
      return {
        ok: true,
        job: {
          providerJobId,
          status: "succeeded",
          error: "",
        },
      };
    },
    async collect(_providerJobId) {
      const { buildFixtureClip, solidFrame } = await import("../video/inspect.ts");
      const { createHash } = await import("node:crypto");
      const frame = solidFrame(80, 142, [30, 30, 30]);
      const bytes = buildFixtureClip({ durationMs: 6000, width: 80, height: 142, frames: [frame] });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        ok: true,
        artifact: {
          mime: "video/mp4",
          bytes,
          durationMs: 6000,
          width: 1080,
          height: 1920,
          sha256,
        },
      };
    },
  };
}

export const timelineVideoEngine = timelineFixtureProvider;

export function videoEngineById(id: string): VideoEngine {
  if (id === "hypit") return hypitVideoEngine();
  if (id === "timeline" || id === "timeline_fixture") return timelineFixtureProvider();
  throw new Error(`Unknown video engine "${id}". Supported: hypit, timeline_fixture.`);
}
