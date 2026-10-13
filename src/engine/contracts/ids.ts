// Prefixed ULIDs (Bible section 4): a fixed prefix, then 26 Crockford base32 characters:
// 10 for the millisecond timestamp and 16 for 80 random bits. Ids sort by time.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { EngineError } from "./errors.ts";

/** Prefixes named in the Bible (req_, dna_, shot_, take_, edl_, vid_) plus the v1 additions. */
export const ID_PREFIXES = [
  "req_",
  "dna_",
  "shot_",
  "take_",
  "edl_",
  "vid_",
  "art_",
  "asp_",
  "res_",
  "cmp_",
  "led_",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME_MS = 2 ** 48 - 1;
const RANDOM_MASK = (1n << 80n) - 1n;
const ULID_BODY = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

/** Pattern of the 26-character ULID body (the first character is 0 to 7 because time fits in 48 bits). */
export const ULID_PATTERN = new RegExp(`^${ULID_BODY}$`);

/** Encode a timestamp and 80 random bits as a 26-character ULID. Pure: same inputs, same output. */
export function encodeUlid(timeMs: number, random: bigint): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
    throw new EngineError("invalid_input", `ULID time must be an integer from 0 to ${MAX_TIME_MS} ms`);
  }
  if (random < 0n || random > RANDOM_MASK) {
    throw new EngineError("invalid_input", "ULID randomness must fit in 80 bits");
  }
  let time = timeMs;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  let rest = random;
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart = CROCKFORD[Number(rest & 31n)] + randomPart;
    rest >>= 5n;
  }
  return timePart + randomPart;
}

function randomBits(): bigint {
  return BigInt(`0x${randomBytes(10).toString("hex")}`);
}

// Within one process, ids created in the same millisecond still increase (ULID monotonic rule).
let lastTime = -1;
let lastRandom = 0n;

function nextUlid(nowMs: number): string {
  if (nowMs > lastTime) {
    lastTime = nowMs;
    lastRandom = randomBits();
  } else if (lastRandom === RANDOM_MASK) {
    lastTime += 1;
    lastRandom = randomBits();
  } else {
    lastRandom += 1n;
  }
  return encodeUlid(lastTime, lastRandom);
}

/** A new prefixed id, e.g. newId("req_"). Ids created later sort later. */
export function newId(prefix: IdPrefix): string {
  return prefix + nextUlid(Date.now());
}

/** Zod schema for an id with the given prefix, e.g. idSchema("req_") accepts "req_" + a valid ULID. */
export function idSchema<P extends IdPrefix>(prefix: P) {
  return z.string().regex(new RegExp(`^${prefix}${ULID_BODY}$`), {
    message: `id must start with ${prefix} and be followed by a 26-character ULID`,
  });
}
