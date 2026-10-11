/**
 * The Meta Ad Library state a workspace sees. The saved key decides whether the library is connected now. A status stored by
 * an earlier run cannot show a connection the workspace no longer has, and a not-connected state always carries the reason
 * the credential resolver gave.
 */

export interface LibraryStateInput {
  /** The saved key, or null when none is usable. */
  keySecret: string | null;
  /** The resolver's reason when there is no usable key. */
  keyReason: string;
  /** The status the last collection run stored, if any. */
  storedStatus: string;
  /** The error the last collection run stored, if any. */
  storedError: string;
}

export function libraryStateFor(input: LibraryStateInput): { status: string; connectionError: string } {
  if (!input.keySecret) return { status: "NOT_CONNECTED", connectionError: input.keyReason };
  // A stored NOT_CONNECTED came from a run that had no key. Now there is one, so the library is available until it is run.
  if (input.storedStatus && input.storedStatus !== "NOT_CONNECTED") {
    return { status: input.storedStatus, connectionError: input.storedError };
  }
  return { status: "AVAILABLE", connectionError: "" };
}
