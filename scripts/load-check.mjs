#!/usr/bin/env node
/**
 * A load check of Meridian's hot paths, with no dependency: concurrent requests for a fixed time, then p50/p95/p99 and the error rate
 * for each path, and a FAIL when a p95 or the error rate is over its limit.
 *
 *   PRODUCT_BASE_URL=https://meridian.example MERIDIAN_LOAD_LINK=<a connector link> npm run load-check
 *
 * Paths: GET /api/health (liveness), GET /api/ready (readiness, reads the database), and, with a connector link, the connector's
 * tools/list and a runner check-in that takes no job. Options: LOAD_CONCURRENCY (default 20), LOAD_SECONDS (default 30). A run against
 * a dev server and its embedded database is a baseline, not a statement of production capacity. Never run it against a server you do
 * not run: it is load.
 */
const base = (process.env.PRODUCT_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const link = process.env.MERIDIAN_LOAD_LINK?.trim() || "";
const concurrency = Math.max(1, Number(process.env.LOAD_CONCURRENCY) || 20);
const seconds = Math.max(1, Number(process.env.LOAD_SECONDS) || 30);

/** Limits a path must stay under. p95 in milliseconds; errors as a share of requests. */
export const LIMITS = { p95Ms: { health: 250, ready: 800, tools: 1500, checkin: 2000 }, errorRate: 0.01 };

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summarise(name, samples) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const throttled = samples.filter((s) => s.throttled).length;
  const p95 = percentile(times, 95);
  const limit = LIMITS.p95Ms[name];
  const errorRate = samples.length ? errors / samples.length : 1;
  const pass = samples.length > 0 && errorRate <= LIMITS.errorRate && p95 !== null && p95 <= limit;
  return { name, requests: samples.length, errors, throttled, errorRate, p50: percentile(times, 50), p95, p99: percentile(times, 99), limit, pass };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

function paths() {
  const list = [
    { name: "health", url: `${base}/api/health`, init: {} },
    // The readiness check answers 503 when, for example, no worker is taking jobs; that is a correct answer, not a load error.
    { name: "ready", url: `${base}/api/ready`, init: {}, okStatuses: [200, 503] },
  ];
  if (link) {
    // A connector link may make 60 calls a minute, so most of these calls are refused with 429 by design. That refusal is the limit
    // working and is counted as throttled, not as an error; its speed is measured like any other answer.
    list.push({ name: "tools", url: link, init: post(rpc("tools/list")), okStatuses: [200], throttleStatus: 429 });
    list.push({ name: "checkin", url: link, init: post(rpc("tools/call", { name: "meridian_runner_next", arguments: { runner: "load-check", problems: [], take: false } })), okStatuses: [200], throttleStatus: 429 });
  }
  return list;
}

async function hammer(path) {
  const samples = [];
  const until = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < until) {
      const started = performance.now();
      let ok = false;
      let throttled = false;
      try {
        const response = await fetch(path.url, { ...path.init, signal: AbortSignal.timeout(10_000) });
        await response.arrayBuffer();
        throttled = path.throttleStatus !== undefined && response.status === path.throttleStatus;
        ok = throttled || (path.okStatuses ?? [200]).includes(response.status);
      } catch {
        ok = false;
      }
      samples.push({ ms: performance.now() - started, ok, throttled });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return summarise(path.name, samples);
}

async function main() {
  const fmt = (n) => (n === null ? "-" : `${Math.round(n)}`);
  console.log(`Load check: ${base}, ${concurrency} at once, ${seconds} s per path${link ? "" : " (no MERIDIAN_LOAD_LINK: connector paths skipped)"}.`);
  const results = [];
  for (const path of paths()) results.push(await hammer(path));
  console.log("path      requests  errors  throttled   p50 ms  p95 ms  p99 ms  limit  result");
  for (const r of results) {
    console.log(`${r.name.padEnd(9)} ${String(r.requests).padStart(8)}  ${String(r.errors).padStart(6)}  ${String(r.throttled).padStart(9)}  ${fmt(r.p50).padStart(7)} ${fmt(r.p95).padStart(7)} ${fmt(r.p99).padStart(7)} ${String(r.limit).padStart(6)}  ${r.pass ? "PASS" : "FAIL"}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? "Load check: PASS" : `Load check: FAIL (${failed.map((r) => r.name).join(", ")})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
