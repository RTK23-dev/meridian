// Provider adapter and router settings (Bible sections 1, 6.6, 10.2 and 10.4). These are the values that src/engine/assets
// held as constants (assets/STATUS.md, "Config (eng-contracts)"). They move here in E3 (adapters@1). The assets code still
// holds its own copies until the lead makes the one-line changes listed in src/engine/contracts/STATUS.md.
//
// Each value the Bible gives is a plain constant. Each value it does not give is an initial value, marked Tunable with a
// floor and a ceiling (config/README.md). The floors and ceilings are proposals; the lead confirms them. The nightly loop
// (Bible 16.2) moves only the values that section names, not these.

import { tunable } from "./tunable.ts";

const MIB = 1024 * 1024;

export const adapters = {
  version: "adapters@1",

  // Bible 1: every master is 1080 x 1920. Stock search and output checks use these, so there is one source.
  output: { width: 1080, height: 1920 },

  // Bible 10.2: reliability and latency are measured over the last 7 days.
  reliabilityWindowMs: 7 * 24 * 60 * 60 * 1000,

  // Bible 6.6 and 10.4: asynchronous jobs are polled with backoff. A retried submit waits base, then twice that, and so on,
  // up to the cap. The number of submits is thresholds.jobs.maxAttempts (Bible 5.1), not repeated here.
  polling: {
    intervalMs: tunable(5_000, 1_000, 30_000),
  },
  retry: {
    backoffBaseMs: tunable(1_000, 250, 10_000),
    backoffCapMs: tunable(30_000, 5_000, 120_000),
  },

  // HTTP timeouts per call. The Bible gives the job lease times (thresholds.jobs.leaseMs), not these.
  timeoutsMs: {
    videoSubmit: tunable(60_000, 10_000, 180_000),
    image: tunable(120_000, 15_000, 300_000),
    speech: tunable(120_000, 15_000, 300_000),
    pexels: tunable(30_000, 5_000, 120_000),
    pixabay: tunable(30_000, 5_000, 120_000),
  },

  // Output checks on what a provider returns (assets/normalise.ts). Bible 6.6 requires the checks, not the sizes. Each
  // byte limit is an initial value. urlMaxLength is a sanity bound on a provider URL.
  outputLimits: {
    imageMinBytes: tunable(1024, 64, 65_536),
    imageMaxBytes: tunable(32 * MIB, 1 * MIB, 128 * MIB),
    speechMinBytes: tunable(1024, 64, 65_536),
    speechMaxBytes: tunable(64 * MIB, 1 * MIB, 256 * MIB),
    urlMaxLength: tunable(2048, 256, 8192),
  },

  // OpenRouter's model catalog (Bible 10.5 step 1, gateway/catalog.ts). A read is kept in memory for this long, per workspace, then
  // read again (the listings are free). Initial value: the Bible says "cached with its read time" and gives no lifetime.
  catalog: {
    ttlMs: tunable(10 * 60_000, 60_000, 6 * 60 * 60_000),
  },

  // Stock search page sizes (assets/providers/pexels.ts, pixabay.ts). Pixabay's documented per_page range is 3 to 200
  // (PROVIDER_APIS.md). The Pexels ceiling is a proposal: PROVIDER_APIS.md does not give one. Integers.
  stock: {
    pexels: { perPage: tunable(15, 1, 80) },
    pixabay: { perPage: tunable(20, 3, 200) },
  },
} as const;
