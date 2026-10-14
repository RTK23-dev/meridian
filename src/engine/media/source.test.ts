// Input handling: the default URL policy, the temporary directory's cleanup, size refusal and fetch status mapping. None
// of these tests runs ffmpeg.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { isPublicHttpsUrl, materialise, withWorkdir } from "../../../functions/ffmpeg/source.ts";
import { FFMPEG_LIMITS } from "../../../functions/ffmpeg/limits.ts";

describe("isPublicHttpsUrl (the default URL policy)", () => {
  const cases: Array<[string, boolean]> = [
    ["https://media.example.com/reel.mp4?sig=abc", true],
    ["https://172.32.0.1/reel.mp4", true],
    ["http://media.example.com/reel.mp4", false],
    ["https://localhost/reel.mp4", false],
    ["https://api.localhost/reel.mp4", false],
    ["https://127.0.0.1/reel.mp4", false],
    ["https://10.1.2.3/reel.mp4", false],
    ["https://192.168.0.9/reel.mp4", false],
    ["https://172.16.0.1/reel.mp4", false],
    ["https://169.254.169.254/latest/meta-data", false],
    ["https://[::1]/reel.mp4", false],
    ["https://user:pass@media.example.com/reel.mp4", false],
    ["https://storage.internal/reel.mp4", false],
  ];
  for (const [url, allowed] of cases) {
    it(`${allowed ? "allows" : "refuses"} ${url}`, () => {
      assert.equal(isPublicHttpsUrl(new URL(url)), allowed);
    });
  }
});

describe("withWorkdir", () => {
  it("creates a temporary directory for the work and removes it afterwards", async () => {
    let seen = "";
    await withWorkdir(async (dir) => {
      seen = dir;
      assert.ok(existsSync(dir));
      assert.match(dir, /meridian-ffmpeg-/);
    });
    assert.equal(existsSync(seen), false);
  });

  it("removes the directory when the work throws", async () => {
    let seen = "";
    await assert.rejects(
      withWorkdir(async (dir) => {
        seen = dir;
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(existsSync(seen), false);
  });
});

describe("materialise", () => {
  it("refuses empty bytes as invalid input before anything is written", async () => {
    await withWorkdir(async (dir) => {
      await assert.rejects(
        materialise({ kind: "bytes", bytes: new Uint8Array(0) }, dir),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
    });
  });

  it("refuses bytes above the input limit without copying them", async () => {
    // A stand-in with only a byte length: the size check runs before any write, so no large buffer is needed.
    const oversized = {
      byteLength: FFMPEG_LIMITS.maxInputBytes + 1,
    } as unknown as Uint8Array<ArrayBuffer>;
    await withWorkdir(async (dir) => {
      await assert.rejects(
        materialise({ kind: "bytes", bytes: oversized }, dir),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
    });
  });

  it("refuses a URL that the policy does not allow, and never fetches it", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response("x");
    }) as unknown as typeof fetch;
    await withWorkdir(async (dir) => {
      await assert.rejects(
        materialise({ kind: "url", url: "http://127.0.0.1/reel.mp4" }, dir, { fetchImpl }),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
    });
    assert.equal(fetches, 0);
  });

  it("writes a fetched body and reports its size", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    await withWorkdir(async (dir) => {
      const media = await materialise(
        { kind: "url", url: "https://media.example.com/reel.mp4" },
        dir,
        {
          fetchImpl,
          urlPolicy: isPublicHttpsUrl,
        },
      );
      assert.equal(media.bytes, 5);
      assert.match(media.path, /input\.media$/);
    });
  });

  const statusCases: Array<[number, string, boolean]> = [
    [404, "not_found", false],
    [410, "not_found", false],
    [403, "provider", false],
    [429, "provider", true],
    [503, "provider", true],
  ];
  for (const [status, kind, retryable] of statusCases) {
    it(`maps HTTP ${status} to ${kind}${retryable ? " (retryable)" : ""}`, async () => {
      const fetchImpl = (async () => new Response("no", { status })) as unknown as typeof fetch;
      await withWorkdir(async (dir) => {
        await assert.rejects(
          materialise({ kind: "url", url: "https://media.example.com/reel.mp4" }, dir, {
            fetchImpl,
          }),
          (error: unknown) =>
            error instanceof EngineError && error.kind === kind && error.retryable === retryable,
        );
      });
    });
  }

  it("treats a network failure as retryable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await withWorkdir(async (dir) => {
      await assert.rejects(
        materialise({ kind: "url", url: "https://media.example.com/reel.mp4" }, dir, { fetchImpl }),
        (error: unknown) =>
          error instanceof EngineError && error.kind === "provider" && error.retryable === true,
      );
    });
  });

  it("refuses a declared size above the limit before reading the body", async () => {
    const headers = new Headers({ "content-length": String(FFMPEG_LIMITS.maxInputBytes + 1) });
    const fetchImpl = (async () =>
      new Response("x", { status: 200, headers })) as unknown as typeof fetch;
    await withWorkdir(async (dir) => {
      await assert.rejects(
        materialise({ kind: "url", url: "https://media.example.com/reel.mp4" }, dir, { fetchImpl }),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
    });
  });
});
