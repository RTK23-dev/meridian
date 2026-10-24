#!/usr/bin/env node
// Measures the public pages in a real browser: status, title, one h1, sideways scrolling at a phone width, console and page errors,
// serious accessibility findings (axe), keyboard reach and focus, and reduced motion. The rules are in public-site-checks.mjs.
//
//   node scripts/public-site-smoke.mjs [baseUrl]        (default http://127.0.0.1:8080, a running dev server)
//
// MERIDIAN_SMOKE_CHROMIUM names an installed Chromium; unset, Playwright uses its own browser. Screenshots go to ./artifacts.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  PUBLIC_SITE_ROUTES,
  SIGNED_OUT_HOME_ROUTE,
  blockingViolations,
  isOwnConsoleError,
  pageFailures,
  summarize,
} from "./public-site-checks.mjs";

// With auth on, `/` is the signed-out front door, and it is checked too. With auth off it is the dashboard, so it is not.
const ROUTES = process.env.PUBLIC_SITE_AUTH_ON === "1" ? [...PUBLIC_SITE_ROUTES, SIGNED_OUT_HOME_ROUTE] : PUBLIC_SITE_ROUTES;

const base = checkedUrl(process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const origin = new URL(base).origin;
const artifactsDir = resolve(process.cwd(), "artifacts");
mkdirSync(artifactsDir, { recursive: true });

/** The passes per page: a desktop pass for keyboard and accessibility, a phone pass for width, and a phone pass under reduced motion. */
const PASSES = [
  { name: "desktop", viewport: DESKTOP_VIEWPORT, keyboard: true, reducedMotion: false },
  { name: "phone", viewport: MOBILE_VIEWPORT, keyboard: false, reducedMotion: false },
  { name: "phone, reduced motion", viewport: MOBILE_VIEWPORT, keyboard: false, reducedMotion: true },
];

/**
 * Presses Tab until focus reaches a link in the public navigation, then reports whether the page draws a visible focus ring on it.
 * Gives up after eight presses, which is past the logo and the first links.
 */
async function focusRingOnNavigation(page) {
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element?.closest('nav[aria-label="Public pages"]')) return { reached: false, ring: false };
      const style = getComputedStyle(element);
      return { reached: true, ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 };
    });
    if (state.reached) return state.ring;
  }
  return false;
}

/** Keyboard reach: the skip link is first and moves focus to main, and the navigation shows a focus ring. Loads the page afresh for each. */
async function keyboardRules(page, url) {
  await page.keyboard.press("Tab");
  const skipLinkFocusedFirst = await page.evaluate(() => document.activeElement?.classList.contains("skip-link") ?? false);
  await page.keyboard.press("Enter");
  const skipLinkMovesFocusToMain = await page.evaluate(() => document.activeElement?.id === "main");
  await page.goto(url, { waitUntil: "networkidle" });
  const focusRingVisible = await focusRingOnNavigation(page);
  return { skipLinkFocusedFirst, skipLinkMovesFocusToMain, focusRingVisible };
}

async function measure(browser, route, pass) {
  const context = await browser.newContext({
    viewport: pass.viewport,
    reducedMotion: pass.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (isOwnConsoleError(message, origin)) consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));

  const url = `${base}${route.path}`;
  const response = await page.goto(url, { waitUntil: "networkidle" });
  const observed = {
    status: response?.status() ?? 0,
    title: await page.title(),
    width: pass.viewport.width,
    h1Count: await page.locator("h1").count(),
    overflowPx: await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)),
    consoleErrors,
    pageErrors,
  };

  if (pass.keyboard) Object.assign(observed, await keyboardRules(page, url));
  if (pass.reducedMotion) {
    // An animation still running under reduced motion is one the global rule in styles.css did not cut. Durations are read in seconds.
    observed.animatedUnderReduce = await page.evaluate(() =>
      [...document.querySelectorAll("*")].filter((element) => {
        const style = getComputedStyle(element);
        if (style.animationName === "none") return false;
        const unit = style.animationDuration.endsWith("ms") ? 0.001 : 1;
        return parseFloat(style.animationDuration) * unit > 0.001;
      }).length,
    );
  }

  const axe = await new AxeBuilder({ page }).analyze();
  observed.seriousViolations = blockingViolations(axe.violations);
  const bodyText = await page.locator("body").innerText();
  observed.missingText = (route.mustContain ?? []).filter((text) => !bodyText.includes(text));

  if (!pass.reducedMotion && pass.name === "phone") {
    const shot = checkedOutputPath(join(artifactsDir, `public-site-${route.slug}-${pass.viewport.width}.png`), [artifactsDir]);
    await page.screenshot({ path: shot, fullPage: true });
  }

  await context.close();
  return {
    label: `${route.path} ${pass.name} (${pass.viewport.width}px)`,
    failures: pageFailures(observed, { title: route.title, keyboard: pass.keyboard, reducedMotion: pass.reducedMotion }),
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.MERIDIAN_SMOKE_CHROMIUM || undefined });
const results = [];
try {
  for (const route of ROUTES) {
    for (const pass of PASSES) {
      results.push(await measure(browser, route, pass));
    }
  }
} finally {
  await browser.close();
}

const summary = summarize(results);
console.log(JSON.stringify({ base, ...summary }, null, 2));
process.exit(summary.ok ? 0 : 1);
