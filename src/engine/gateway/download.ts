// Downloads a finished provider file (a generated take, a stock clip) through the gateway (Video Engine Bible 6.6 step 4).
// Engine code never calls fetch, so the bytes come through the gateway's transport for the provider. A URL on the provider's own
// host is authenticated; any other URL (a CDN or a signed link) is sent with no credential. Only https is accepted, the size is
// bounded before the bytes are returned, and a non-2xx answer is an error, never an empty file.

import { EngineError } from "../contracts/errors.ts";
import type { Gateway } from "./gateway.ts";

export type DownloadInput = {
  /** The gateway provider the URL belongs to, for example "openrouter" or "pexels". */
  providerId: string;
  organizationId: string | null;
  url: string;
  /** The largest file accepted, in bytes. A larger answer is refused. */
  maxBytes: number;
  signal?: AbortSignal;
};

/** The download port the produce handler uses. Tests replace it with recorded bytes. */
export interface MediaDownloader {
  download(input: DownloadInput): Promise<Uint8Array<ArrayBuffer>>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** The https URL, checked. A non-https or unparsable URL is refused before anything is sent. */
export function httpsUrlOrThrow(url: string, stage: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EngineError("invalid_input", "the download URL is not a URL", { stage, retryable: false });
  }
  if (parsed.protocol !== "https:") {
    throw new EngineError("invalid_input", "only https downloads are accepted", { stage, retryable: false });
  }
  return parsed.toString();
}

/** A MediaDownloader over the gateway's transport for each provider. */
export function gatewayDownloader(gateway: Gateway): MediaDownloader {
  return {
    async download(input): Promise<Uint8Array<ArrayBuffer>> {
      const url = httpsUrlOrThrow(input.url, "produce_shot");
      if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new EngineError("config", "a download needs a positive byte limit", { stage: "produce_shot", retryable: false });
      }
      const transport = gateway.transportFor(input.providerId, input.organizationId);
      const response = await transport({ method: "GET", url, headers: {}, ...(input.signal ? { signal: input.signal } : {}) });
      if (response.status < 200 || response.status >= 300) {
        const retryable = response.status >= 500 || RETRYABLE_STATUS.has(response.status);
        throw new EngineError("provider", `the download from ${input.providerId} answered HTTP ${response.status}`, {
          retryable,
          stage: "produce_shot",
        });
      }
      if (response.body.byteLength === 0) {
        throw new EngineError("invalid_input", `the download from ${input.providerId} is empty`, { stage: "produce_shot", retryable: false });
      }
      if (response.body.byteLength > input.maxBytes) {
        throw new EngineError("invalid_input", `the download from ${input.providerId} is above the ${input.maxBytes} byte limit`, {
          stage: "produce_shot",
          retryable: false,
        });
      }
      return new Uint8Array(response.body);
    },
  };
}
