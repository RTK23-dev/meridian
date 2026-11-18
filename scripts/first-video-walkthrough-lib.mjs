/**
 * The pure parts of the first-video walkthrough (first-video-walkthrough.mjs): the base URL it may run against, the account it signs up
 * with, the step timer and the verdict. Kept apart from the browser so they are tested without one.
 */

/** The whole walkthrough must finish within this wall time: a new person reaches a requested free video in under 10 minutes. */
export const WALKTHROUGH_LIMIT_MS = 10 * 60 * 1000;

/** The app's origin from PRODUCT_BASE_URL. Only an http(s) origin with no credentials, path, query or fragment is accepted. */
export function walkthroughBase(value = "http://127.0.0.1:8080") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PRODUCT_BASE_URL is not a URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("PRODUCT_BASE_URL must be an http(s) origin with no credentials, path, query or fragment.");
  }
  return url.origin;
}

/** A fresh account for one run, so a run never reuses another run's workspace. The address is on the reserved example.com domain. */
export function walkthroughAccount(now = Date.now(), random = Math.random) {
  const tag = `${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`;
  return {
    name: "First Video Walkthrough",
    email: `first-video-${tag}@example.com`,
    password: `Walkthrough-${tag}-1`,
    workspace: `First video ${tag}`,
    brand: `Walkthrough Brand ${tag}`,
  };
}

/** Records how long each named step took. `run` times one step and rethrows its failure, after recording it as failed. */
export function stepTimer(now = () => Date.now()) {
  const started = now();
  const steps = [];
  return {
    steps,
    async run(name, work) {
      const at = now();
      try {
        const value = await work();
        steps.push({ name, ms: now() - at, ok: true });
        return value;
      } catch (error) {
        steps.push({ name, ms: now() - at, ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
        throw error;
      }
    },
    elapsed: () => now() - started,
  };
}

/**
 * The run's verdict. It passes only when every step passed, all expected steps ran, the wall time stayed within the limit and the page
 * logged no uncaught error. Each reason it fails is named.
 */
export function walkthroughVerdict({ steps, expected, totalMs, pageErrors, limitMs = WALKTHROUGH_LIMIT_MS }) {
  const reasons = [];
  for (const step of steps) if (!step.ok) reasons.push(`step "${step.name}" failed: ${step.error}`);
  const ran = new Set(steps.map((step) => step.name));
  const missing = expected.filter((name) => !ran.has(name));
  if (missing.length > 0) reasons.push(`steps that did not run: ${missing.join(", ")}`);
  if (totalMs > limitMs) reasons.push(`the walkthrough took ${seconds(totalMs)}, over the ${seconds(limitMs)} limit`);
  if (pageErrors.length > 0) reasons.push(`${pageErrors.length} page error(s): ${pageErrors.slice(0, 3).join(" | ")}`);
  return { pass: reasons.length === 0, reasons };
}

export function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One line per step, then the SUMMARY line a CI log is searched for. */
export function walkthroughReport({ steps, totalMs, verdict }) {
  const lines = steps.map((step) => `${step.ok ? "PASS" : "FAIL"} ${step.name.padEnd(28)} ${seconds(step.ms).padStart(8)}${step.ok ? "" : `  ${step.error}`}`);
  lines.push(`SUMMARY first-video walkthrough ${verdict.pass ? "PASSED" : "FAILED"} in ${seconds(totalMs)} (${steps.filter((step) => step.ok).length}/${steps.length} steps)`);
  for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}
