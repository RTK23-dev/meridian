/**
 * The pass and fail rules for the public pages, kept apart from the browser so each rule can be tested with fixtures.
 * scripts/public-site-smoke.mjs measures a real page and hands the numbers here. A page passes only when every rule holds.
 */

export const PUBLIC_SITE_ROUTES = [
  { path: "/product", title: "Product · Meridian", keyboard: true },
  { path: "/docs", title: "Docs · Meridian", keyboard: false },
  { path: "/quickstart", title: "Quickstart · Meridian", keyboard: false },
];

export const MOBILE_VIEWPORT = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

/**
 * The failures for one page. `observed` is what the browser measured; `expected` says which rules apply. A keyboard rule applies only
 * where the page was tested for keyboard use, and the reduced-motion rule only where it was tested under reduced motion.
 * @returns {string[]} the failures, empty when the page passes
 */
export function pageFailures(observed, expected) {
  const failures = [];
  if (observed.status !== 200) failures.push(`answered ${observed.status}, not 200`);
  if (observed.title !== expected.title) failures.push(`title is "${observed.title}", expected "${expected.title}"`);
  if (observed.h1Count !== 1) failures.push(`has ${observed.h1Count} h1 headings, expected one`);
  if (observed.overflowPx > 0) failures.push(`scrolls sideways by ${observed.overflowPx}px at ${observed.width}px wide`);
  for (const message of observed.consoleErrors ?? []) failures.push(`console error: ${message}`);
  for (const message of observed.pageErrors ?? []) failures.push(`page error: ${message}`);
  for (const violation of observed.seriousViolations ?? []) {
    failures.push(`accessibility ${violation.impact}: ${violation.id} (${violation.nodes.join(", ") || "no node"})`);
  }
  if (expected.keyboard) {
    if (!observed.skipLinkFocusedFirst) failures.push("the first Tab does not focus the skip link");
    if (!observed.skipLinkMovesFocusToMain) failures.push("activating the skip link does not move focus to main");
    if (!observed.focusRingVisible) failures.push("the focused navigation link has no visible focus ring");
  }
  if (expected.reducedMotion && (observed.animatedUnderReduce ?? 0) > 0) {
    failures.push(`${observed.animatedUnderReduce} element(s) still animate under reduced motion`);
  }
  return failures;
}

/** Keeps only the axe results a person can be blocked by: serious and critical. Minor findings stay in the report, not the verdict. */
export function blockingViolations(axeViolations) {
  return axeViolations
    .filter((item) => item.impact === "serious" || item.impact === "critical")
    .map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
}

/**
 * A console error from the app's own origin counts. One from a third-party host does not: a font or script the sandbox cannot reach is
 * the network, not the page.
 */
export function isOwnConsoleError(message, baseOrigin) {
  if (message.type !== "error") return false;
  const url = message.location?.url ?? "";
  if (!url) return true;
  try {
    return new URL(url).origin === baseOrigin;
  } catch {
    return true;
  }
}

/** One line for the report: the route, the width and each failure. */
export function summarize(results) {
  const failed = results.filter((result) => result.failures.length > 0);
  return { ok: failed.length === 0, checked: results.length, failed: failed.map((result) => ({ label: result.label, failures: result.failures })) };
}
