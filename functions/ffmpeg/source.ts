// Input handling. Media arrives as bytes or as a URL that the function fetches itself. ffmpeg never reads a URL: the
// bytes are written to a file inside a temporary directory that this module creates and always removes.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { assertInputSize, type MediaSource } from "./types.ts";

/** Decides whether a URL may be fetched. The default allows only public https addresses (see isPublicHttpsUrl). */
export type UrlPolicy = (url: URL) => boolean;

export type SourceOptions = {
  urlPolicy?: UrlPolicy;
  fetchImpl?: typeof fetch;
};

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
];
const PRIVATE_HOSTNAMES = [/^localhost$/, /\.localhost$/, /\.internal$/, /\.local$/];

/**
 * The default URL policy: https only, no credentials in the URL, no private or loopback host names or IPv4 literals,
 * and no IPv6 literals. This does not stop DNS names that resolve to private addresses. Egress control belongs to the
 * deployment (see functions/ffmpeg/STATUS.md).
 */
export function isPublicHttpsUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    return false;
  }
  if (PRIVATE_HOSTNAMES.some((pattern) => pattern.test(host))) {
    return false;
  }
  return !PRIVATE_IPV4.some((pattern) => pattern.test(host));
}

/**
 * Runs work in a fresh temporary directory and removes it afterwards, also when the work throws. Nothing the handlers
 * write goes anywhere else.
 */
export async function withWorkdir<Result>(work: (dir: string) => Promise<Result>): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), "meridian-ffmpeg-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Materialised = { path: string; bytes: number };

/** Writes the media into dir as input.media and returns its path and size. */
export async function materialise(
  source: MediaSource,
  dir: string,
  options: SourceOptions = {},
): Promise<Materialised> {
  const path = join(dir, "input.media");
  if (source.kind === "bytes") {
    assertInputSize(source.bytes.byteLength, "media.source");
    await writeFile(path, source.bytes);
    return { path, bytes: source.bytes.byteLength };
  }
  const url = new URL(source.url);
  const policy = options.urlPolicy ?? isPublicHttpsUrl;
  if (!policy(url)) {
    throw new EngineError(
      "invalid_input",
      "the media URL is not allowed by this function's URL policy",
      {
        stage: "media.source",
      },
    );
  }
  const data = await fetchBounded(url, options.fetchImpl ?? fetch);
  await writeFile(path, data);
  return { path, bytes: data.byteLength };
}

function statusError(status: number): EngineError {
  if (status === 404 || status === 410) {
    return new EngineError("not_found", `the media URL answered HTTP ${status}`, {
      stage: "media.source",
    });
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return new EngineError("provider", `the media URL answered HTTP ${status}`, {
    retryable,
    stage: "media.source",
  });
}

async function fetchBounded(url: URL, fetchImpl: typeof fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    // redirect: "error" stops a redirect from sending the fetch to an address the policy never checked.
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FFMPEG_LIMITS.urlFetchTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError("provider", `the media URL could not be fetched: ${reason}`, {
      retryable: true,
      stage: "media.source",
      cause: error,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw statusError(response.status);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FFMPEG_LIMITS.maxInputBytes) {
    await response.body?.cancel();
    throw new EngineError(
      "invalid_input",
      `the media is ${declared} bytes, above the ${FFMPEG_LIMITS.maxInputBytes} byte limit`,
      {
        stage: "media.source",
      },
    );
  }
  if (!response.body) {
    throw new EngineError("invalid_input", "the media URL returned no body", {
      stage: "media.source",
    });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > FFMPEG_LIMITS.maxInputBytes) {
      await reader.cancel();
      throw new EngineError(
        "invalid_input",
        `the media is larger than the ${FFMPEG_LIMITS.maxInputBytes} byte limit`,
        {
          stage: "media.source",
        },
      );
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertInputSize(data.byteLength, "media.source");
  return data;
}
