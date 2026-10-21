/**
 * Drafts that survive a reload, kept per person, per workspace and per screen. The storage is any object with these three
 * methods, so tests pass a fake. Every call is wrapped in try/catch, so a blocked or full store never breaks a screen.
 */
export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type DraftScope = { userId: string; workspaceId: string; screen: string };

/** a-z, 0-9 and hyphen stay as they are. Every other character becomes "_" and its six-digit hex code point, so two different ids never share a key. */
function keyPart(value: string): string {
  return Array.from(value, (char) => {
    if (/^[a-z0-9-]$/.test(char)) return char;
    const code = char.codePointAt(0) ?? 0;
    return `_${code.toString(16).padStart(6, "0")}`;
  }).join("");
}

/** The storage key for one person's draft on one screen of one workspace. The same scope always gives the same key. */
export function draftKey(scope: DraftScope): string {
  return ["meridian", "draft", keyPart(scope.userId), keyPart(scope.workspaceId), keyPart(scope.screen)].join(":");
}

export function createDraftStore(storage: DraftStorage) {
  return {
    /** The saved value, or null when there is none, the JSON is bad or the store cannot be read. The value is data from storage, so validate it before use. */
    read<T = unknown>(key: string): T | null {
      try {
        const raw = storage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    /** Returns false when the value could not be saved, so the screen can say so. */
    write(key: string, value: unknown): boolean {
      try {
        const text = JSON.stringify(value);
        if (typeof text !== "string") return false;
        storage.setItem(key, text);
        return true;
      } catch {
        return false;
      }
    },
    /** Returns false when the draft could not be removed. */
    clear(key: string): boolean {
      try {
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
