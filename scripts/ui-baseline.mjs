#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const baseUrl = checkedUrl(process.env.UI_BASELINE_URL || "http://127.0.0.1:8080/");
const root = resolve(process.env.UI_BASELINE_DIR || "docs/ui-baseline");
const outputRoot = resolve(process.env.UI_BASELINE_OUTPUT_ROOT || process.cwd());
const outputDir = checkedOutputPath(root, [outputRoot], "baseline output");
const maxRoutes = Number(process.env.UI_BASELINE_MAX_ROUTES || 60);
const widths = [390, 768, 1440];
const themes = ["light", "dark"];
const explicitRoutes = (process.env.UI_BASELINE_ROUTES || "")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);
const testUser = {
  name: process.env.UI_BASELINE_NAME || "Meridian UI baseline fixture",
  email: process.env.UI_BASELINE_EMAIL || "ui-baseline@meridian.invalid",
  password: process.env.UI_BASELINE_PASSWORD || "BaselinePass123!",
};

function routeKey(url) {
  const path = new URL(url).pathname;
  const slug = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "home";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

async function discoverRoutes(page) {
  const pending = [baseUrl, ...explicitRoutes.map((path) => new URL(path, baseUrl).href)];
  const visited = new Set();
  while (pending.length && visited.size < maxRoutes) {
    const next = pending.shift();
    if (!next || visited.has(next)) continue;
    const parsed = new URL(next);
    if (parsed.origin !== new URL(baseUrl).origin || parsed.pathname.startsWith("/api/")) continue;
    visited.add(next);
    await page.goto(next, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 10_000 }).catch(() => undefined);
    const links = await page.locator("a[href]").evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.href),
    ).catch(() => []);
    for (const href of links) {
      const link = new URL(href);
      if (link.origin === new URL(baseUrl).origin && !link.pathname.startsWith("/api/")) {
        link.hash = "";
        if (!visited.has(link.href) && !pending.includes(link.href)) pending.push(link.href);
      }
    }
  }
  return [...visited];
}

async function prepareFixtureWorkspace(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForFunction(
    () => document.body.innerText.includes("Create account") || document.body.innerText.includes("Sign out"),
    undefined,
    { timeout: 15_000 },
  );
  if (await page.getByRole("button", { name: "Create account", exact: true }).count()) {
    await page.getByLabel("Your name").fill(testUser.name);
    await page.getByLabel("Email").fill(testUser.email);
    await page.getByLabel("Password").fill(testUser.password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.waitForTimeout(800);
    if (await page.getByRole("button", { name: "Create account", exact: true }).count()) {
      await page.getByRole("button", { name: "I already have an account" }).click();
      await page.getByLabel("Email").fill(testUser.email);
      await page.getByLabel("Password").fill(testUser.password);
      await page.getByRole("button", { name: "Sign in with email" }).click();
    }
  }
  await page.getByText("Sign out", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });

  if (await page.getByRole("button", { name: "Create workspace", exact: true }).count()) {
    await page.locator("form input").first().fill("Meridian UI baseline fixture");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.getByRole("link", { name: "New brand", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  const homeText = await page.locator("body").innerText();
  if (homeText.includes("No brands yet.")) {
    await page.goto(new URL("/brands/new", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Brand name").fill("UI baseline fixture (not a real brand)");
    await page.getByLabel("What do you sell?").fill("Screenshot fixture only; no real product or business claim.");
    await page.getByRole("button", { name: "Create brand", exact: true }).click();
    await page.getByText("UI baseline fixture (not a real brand)", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }

  const signedInText = await page.locator("body").innerText();
  if (!signedInText.includes("Sign out")) {
    throw new Error(`UI baseline could not sign in with the local test account: ${signedInText.slice(0, 300)}`);
  }
  if (signedInText.includes("Name the workspace")) {
    throw new Error("UI baseline could not prepare its PGlite test workspace.");
  }
}

mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const discoveryContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const discoveryPage = await discoveryContext.newPage();
  await prepareFixtureWorkspace(discoveryPage);
  const routes = await discoverRoutes(discoveryPage);
  const storageState = await discoveryContext.storageState();
  await discoveryContext.close();

  const captures = [];
  for (const theme of themes) {
    const context = await browser.newContext({ colorScheme: theme, storageState });
    const page = await context.newPage();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      for (const url of routes) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 10_000 }).catch(() => undefined);
        const routeDir = join(outputDir, routeKey(url));
        mkdirSync(routeDir, { recursive: true });
        const path = join(routeDir, `${width}-${theme}.png`);
        await page.screenshot({ path, fullPage: true });
        captures.push({ url, width, theme, path });
      }
    }
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, routes: routes.length, captureCount: captures.length, outputDir, captures }, null, 2));
} finally {
  await browser.close();
}
