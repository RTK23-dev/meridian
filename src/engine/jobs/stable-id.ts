// Ids that do not change when a job runs again. A produce or check job that is retried must name the same take, or the same
// spec, so the ledger key and the artifacts line up. The id is a sha256 of the label, written as a ULID: 48 bits of time from the
// digest and 80 bits of randomness from the rest. Like planReservationId (handlers/estimate-reserve.ts), it is not a timestamp.

import { createHash } from "node:crypto";
import { encodeUlid, type IdPrefix } from "../contracts/index.ts";

export function stableId(prefix: IdPrefix, label: string): string {
  const digest = createHash("sha256").update(label).digest();
  const time = digest.readUIntBE(0, 6);
  const random = BigInt(`0x${digest.subarray(6, 16).toString("hex")}`);
  return prefix + encodeUlid(time, random);
}

/** A 32-bit seed for one asset call, from its request, shot and attempt. A redo has a new attempt, so it has a new seed. */
export function seedFor(label: string): number {
  return createHash("sha256").update(`seed|${label}`).digest().readUInt32BE(0);
}
