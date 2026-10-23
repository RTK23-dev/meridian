import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pinnedLookup } from "./transport.ts";

const CHECKED = [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
];

/** Calls the lookup the way Node's connection does, and resolves with what it answered. */
function ask(options: { all?: boolean; family?: number }): Promise<{ error: Error | null; answer: unknown; family?: number }> {
  return new Promise((resolve) => {
    pinnedLookup(CHECKED)("download.example.com", options, (error: unknown, answer: unknown, family?: number) => {
      resolve({ error: error as Error | null, answer, ...(family === undefined ? {} : { family }) });
    });
  });
}

describe("pinnedLookup: a download connects only to the addresses it checked", () => {
  it("answers with every checked address when the connection asks for all of them", async () => {
    const { error, answer } = await ask({ all: true });
    assert.equal(error, null);
    assert.deepEqual(answer, CHECKED);
  });

  it("answers with one checked address, of the requested family", async () => {
    const v4 = await ask({ family: 4 });
    assert.equal(v4.error, null);
    assert.equal(v4.answer, "93.184.216.34");
    assert.equal(v4.family, 4);
    const v6 = await ask({ family: 6 });
    assert.equal(v6.answer, "2606:2800:220:1:248:1893:25c8:1946");
  });

  it("answers with a checked address when no family is asked for", async () => {
    const { error, answer, family } = await ask({});
    assert.equal(error, null);
    assert.equal(answer, "93.184.216.34");
    assert.equal(family, 4);
  });

  it("refuses with no answer when no checked address has the requested family", async () => {
    const onlyV4 = pinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    await new Promise<void>((resolve) => {
      onlyV4("download.example.com", { family: 6 }, (error: unknown, answer: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, "ENOTFOUND");
        assert.equal(answer, "");
        resolve();
      });
    });
  });
});
