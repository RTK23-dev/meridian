/**
 * localStorage can be blocked, full or absent (private windows, embedded previews). Every read and write in the
 * navigation code goes through these helpers, which never throw.
 */
export function readLocal(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable. The in-memory value still applies for this visit.
  }
}
