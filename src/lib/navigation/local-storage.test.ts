import assert from "node:assert/strict";
import test from "node:test";
import { readLocal, writeLocal } from "./local-storage.ts";

type FakeWindow = { localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } };

/** Runs `body` with a fake `window` in place, then restores the previous global. */
function withWindow<T>(fake: FakeWindow | undefined, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (fake === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, "window", { value: fake, configurable: true, writable: true });
  try {
    return body();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
}

function memoryWindow(): FakeWindow & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value); },
    },
  };
}

test("without a window, reads give nothing and writes do nothing", () => {
  withWindow(undefined, () => {
    assert.equal(readLocal("meridian-last-brand"), null);
    assert.doesNotThrow(() => writeLocal("meridian-last-brand", "b1"));
  });
});

test("reads and writes round-trip through the browser storage", () => {
  const fake = memoryWindow();
  withWindow(fake, () => {
    writeLocal("meridian-nav-collapsed", "true");
    assert.equal(readLocal("meridian-nav-collapsed"), "true");
    assert.equal(readLocal("missing"), null);
  });
  assert.equal(fake.data.get("meridian-nav-collapsed"), "true");
});

test("storage that throws on read gives null and never breaks the page", () => {
  const blocked: FakeWindow = {
    localStorage: {
      getItem: () => { throw new Error("SecurityError: storage is blocked"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    },
  };
  withWindow(blocked, () => {
    assert.equal(readLocal("meridian-last-brand"), null);
    assert.doesNotThrow(() => writeLocal("meridian-last-brand", "b1"));
  });
});

test("a window with no storage at all gives null and never breaks the page", () => {
  const noStorage = {} as unknown as FakeWindow;
  withWindow(noStorage, () => {
    assert.equal(readLocal("meridian-last-brand"), null);
    assert.doesNotThrow(() => writeLocal("meridian-last-brand", "b1"));
  });
});
