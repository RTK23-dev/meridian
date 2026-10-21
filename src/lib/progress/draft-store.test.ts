import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore, draftKey, type DraftStorage } from "./draft-store.ts";

/** A storage that keeps strings in a Map, with a failure switch for each method. */
function fakeStorage(options: { failGet?: boolean; failSet?: boolean; failRemove?: boolean } = {}) {
  const items = new Map<string, string>();
  const storage: DraftStorage = {
    getItem(key) {
      if (options.failGet) throw new Error("storage is blocked");
      return items.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failSet) throw new Error("storage is full");
      items.set(key, value);
    },
    removeItem(key) {
      if (options.failRemove) throw new Error("storage is blocked");
      items.delete(key);
    },
  };
  return { storage, items };
}

const SAFE_KEY = /^[a-z0-9:_-]+$/;

test("a draft key is stable and uses only a-z, 0-9, colon, underscore and hyphen", () => {
  const scope = { userId: "User.One@Example", workspaceId: "org_ABC 12", screen: "create-brief" };
  const key = draftKey(scope);
  assert.equal(key, draftKey(scope));
  assert.match(key, SAFE_KEY);
});

test("two ids that differ only in case or punctuation get different keys", () => {
  const base = { workspaceId: "org_1", screen: "brief" };
  assert.notEqual(draftKey({ ...base, userId: "abc" }), draftKey({ ...base, userId: "ABC" }));
  assert.notEqual(draftKey({ ...base, userId: "a.b" }), draftKey({ ...base, userId: "a_b" }));
  assert.notEqual(draftKey({ ...base, userId: "a:b" }), draftKey({ ...base, userId: "a-b" }));
});

test("a draft key changes with the person, the workspace and the screen", () => {
  const scope = { userId: "u1", workspaceId: "w1", screen: "brief" };
  const keys = new Set([
    draftKey(scope),
    draftKey({ ...scope, userId: "u2" }),
    draftKey({ ...scope, workspaceId: "w2" }),
    draftKey({ ...scope, screen: "plan" }),
  ]);
  assert.equal(keys.size, 4);
});

test("a value that is written is read back unchanged", () => {
  const store = createDraftStore(fakeStorage().storage);
  const key = draftKey({ userId: "u1", workspaceId: "w1", screen: "brief" });
  assert.equal(store.write(key, { goal: "A 30-second video", budget: 2 }), true);
  assert.deepEqual(store.read(key), { goal: "A 30-second video", budget: 2 });
});

test("a key with nothing saved reads as null", () => {
  assert.equal(createDraftStore(fakeStorage().storage).read("meridian:draft:none"), null);
});

test("saved text that is not JSON reads as null instead of throwing", () => {
  const { storage, items } = fakeStorage();
  items.set("meridian:draft:bad", "{not json");
  assert.equal(createDraftStore(storage).read("meridian:draft:bad"), null);
});

test("a store that cannot be used reads as null, and a failed write or clear says so without throwing", () => {
  const store = createDraftStore(fakeStorage({ failGet: true, failSet: true, failRemove: true }).storage);
  assert.equal(store.read("meridian:draft:any"), null);
  assert.equal(store.write("meridian:draft:any", { text: "kept on screen" }), false);
  assert.equal(store.clear("meridian:draft:any"), false);
});

test("clear removes a saved draft", () => {
  const store = createDraftStore(fakeStorage().storage);
  store.write("meridian:draft:x", "saved");
  assert.equal(store.clear("meridian:draft:x"), true);
  assert.equal(store.read("meridian:draft:x"), null);
});
