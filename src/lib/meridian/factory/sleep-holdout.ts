/**
 * The holdout and the challenger arms for sleep mode (Bible 16.3 and 11.3). Both are deterministic: a hash of the item's id (or
 * of the call's key) decides the arm, so the same item gets the same arm on every night, and no random number is drawn.
 */
import { createHash } from "node:crypto";

/** A number in [0, 1) from the first four bytes of a SHA-256 of the key. Pure. */
export function drawOf(key: string): number {
  return createHash("sha256").update(key, "utf8").digest().readUInt32BE(0) / 0x100000000;
}

export type HoldoutArm = "holdout" | "treated";

/**
 * The arm of one planned item. An item is held out when its draw is below the share, so a share of 0 holds nothing and a share of
 * 1 holds everything. The share must be between 0 and 1, or the call throws.
 */
export function holdoutArmOf(itemId: string, holdoutShare: number): HoldoutArm {
  if (!(holdoutShare >= 0 && holdoutShare <= 1)) throw new Error("The holdout share must be between 0 and 1.");
  return drawOf(`holdout:${itemId}`) < holdoutShare ? "holdout" : "treated";
}

/** Template ids production must not make. A treated arm, or a run with no assignment, is not in the set. */
export function holdoutItemIds(rows: ReadonlyArray<{ item_id: string; arm: string }>): Set<string> {
  return new Set(rows.filter((row) => row.arm === "holdout").map((row) => row.item_id));
}

export type ChallengerChoice =
  | { arm: "control"; version: null; reason: string }
  | { arm: "challenger"; version: string; reason: string };

/**
 * The prompt arm of one role call. With no challenger version registered, every call is control, and the reason says that no
 * challenger ran. With versions registered, the share of calls is chosen by a draw, and the version by a second draw.
 */
export function challengerArmOf(callKey: string, challengerShare: number, versions: readonly string[]): ChallengerChoice {
  if (versions.length === 0) {
    return { arm: "control", version: null, reason: "No challenger prompt version is registered, so no challenger ran." };
  }
  if (!(challengerShare >= 0 && challengerShare <= 1)) throw new Error("The challenger share must be between 0 and 1.");
  if (drawOf(`challenger:${callKey}`) >= challengerShare) {
    return { arm: "control", version: null, reason: "This call was not chosen for the challenger share." };
  }
  const index = Math.min(versions.length - 1, Math.floor(drawOf(`version:${callKey}`) * versions.length));
  const version = versions[index];
  if (!version) return { arm: "control", version: null, reason: "No challenger version could be chosen for this call." };
  return { arm: "challenger", version, reason: "Chosen for the challenger share." };
}
