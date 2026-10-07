#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve, join, relative, extname, sep } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const baseUrl = checkedUrl(process.env.UI_BASELINE_URL || "http://127.0.0.1:8080/");
const root = resolve(process.env.UI_BASELINE_DIR || "docs/ui-baseline");
const outputRoot = resolve(process.env.UI_BASELINE_OUTPUT_ROOT || process.cwd());
const outputDir = checkedOutputPath(root, [outputRoot], "baseline output");
const widths = [360, 390, 768, 1024, 1440];
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

async function discoverRoutes(page, seededBrandId) {
  const pending = [baseUrl, ...explicitRoutes.map((path) => new URL(path, baseUrl).href)];
  const visited = new Set();
  while (pending.length) {
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
  const brandId = [...visited]
    .map((url) => new URL(url).pathname.match(/^\/brands\/([^/]+)/)?.[1])
    .find((value) => value && value !== "new") || seededBrandId;
  const routeFiles = readdirSync("src/routes", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".tsx")
    .map((entry) => relative("src/routes", join(entry.parentPath, entry.name)))
    .filter((file) => file !== "__root.tsx" && !file.includes("[_design]"));
  const sourceRoutes = routeFiles.map((file) => {
    const route = file === "index.tsx"
      ? ""
      : file
          .split(sep)
          .join("/")
          .replace(/\.tsx$/, "")
          .replace(/\/index$/, "")
          .split("/")
          .map((part) => part.replace(/^\[([^\]]+)\]$/, "$1"))
          .join("/");
    return `/${route.split("/").map((part) => {
      if (!part.startsWith("$")) return part;
      if (!brandId) throw new Error(`Cannot capture dynamic route ${file}: no seeded brand route was discovered.`);
      return brandId;
    }).join("/")}`;
  });
  return [...new Set([...visited, ...sourceRoutes.map((path) => new URL(path, baseUrl).href)])];
}

async function prepareFixtureWorkspace(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForFunction(
    () => document.body.innerText.includes("Create account") || Boolean(document.querySelector('[aria-label="Account and appearance settings"]')),
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
  await page.getByRole("button", { name: "Account and appearance settings", exact: true }).waitFor({ state: "visible", timeout: 15_000 });

  const onboardingHeading = page.getByRole("heading", { name: "Name the workspace", exact: true });
  const overviewHeading = page.getByRole("heading", { name: "Workspace overview", exact: true });
  await page.waitForFunction(() => {
    const headings = [...document.querySelectorAll("h1, h2")].map((heading) => heading.textContent?.trim());
    return headings.includes("Name the workspace") || headings.includes("Workspace overview");
  }, undefined, { timeout: 15_000 });

  let createdFixtureWorkspace = false;
  if (await onboardingHeading.isVisible()) {
    await page.locator("form input").first().fill("Meridian UI baseline fixture");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    try {
      await onboardingHeading.waitFor({ state: "detached", timeout: 20_000 });
      await overviewHeading.waitFor({ state: "visible", timeout: 15_000 });
      createdFixtureWorkspace = true;
    } catch {
      const bodyText = await page.locator("body").innerText().catch(() => "<page body unavailable>");
      const alertText = await page.getByRole("alert").allInnerTexts().catch(() => []);
      throw new Error(`UI baseline could not create its fixture workspace. Alerts: ${alertText.join(" | ") || "none"}. Page content: ${bodyText.slice(-1_200)}`);
    }
  }

  // Creating the workspace awaits the refreshed bootstrap data and waits for the
  // overview above. Keep that confirmed page state instead of issuing a second
  // bootstrap request that can race the just-completed onboarding mutation.
  if (!createdFixtureWorkspace && !(await overviewHeading.isVisible())) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  try {
    await onboardingHeading.waitFor({ state: "detached", timeout: 15_000 });
    await overviewHeading.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // A full navigation asks for the persisted workspace again if bootstrap was stale.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    try {
      await onboardingHeading.waitFor({ state: "detached", timeout: 15_000 });
      await overviewHeading.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      const bodyText = await page.locator("body").innerText().catch(() => "<page body unavailable>");
      throw new Error(`UI baseline could not load the workspace overview after creating the fixture workspace. Page content: ${bodyText.slice(0, 600)}`);
    }
  }
  const linkedBrandId = await page.locator('a[href^="/brands/"]').evaluateAll((anchors) =>
    anchors.map((anchor) => new URL(anchor.href).pathname.match(/^\/brands\/([^/]+)/)?.[1])
      .find((value) => value && value !== "new"),
  );
  if (!linkedBrandId) {
    await page.goto(new URL("/brands/new", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Brand name").fill("UI baseline fixture (not a real brand)");
    await page.getByLabel("What do you sell?").fill("Screenshot fixture only; no real product or business claim.");
    await page.getByRole("button", { name: "Create brand", exact: true }).click();
    await page.waitForURL((url) => /^\/brands\/(?!new$)[^/]+$/.test(url.pathname), { timeout: 15_000 });
  }

  const signedInText = await page.locator("body").innerText();
  if (!(await page.getByRole("button", { name: "Account and appearance settings", exact: true }).count())) {
    throw new Error(`UI baseline could not sign in with the local test account: ${signedInText.slice(0, 300)}`);
  }
  if (signedInText.includes("Name the workspace")) {
    throw new Error("UI baseline could not prepare its PGlite test workspace.");
  }

  const currentBrandId = new URL(page.url()).pathname.match(/^\/brands\/([^/]+)/)?.[1];
  return (currentBrandId && currentBrandId !== "new" ? currentBrandId : undefined) || linkedBrandId;
}

mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const discoveryContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const discoveryPage = await discoveryContext.newPage();
  const seededBrandId = await prepareFixtureWorkspace(discoveryPage);
  const discoveredRoutes = await discoverRoutes(discoveryPage, seededBrandId);
  const captureFilter = (process.env.UI_BASELINE_CAPTURE_ROUTES || "").split(",").map((route) => route.trim()).filter(Boolean);
  const routes = captureFilter.length
    ? discoveredRoutes.filter((url) => captureFilter.some((route) => new URL(url).pathname === route || new URL(url).pathname.startsWith(`${route}/`)))
    : discoveredRoutes;
  if (!routes.length) throw new Error("The UI baseline route filter did not match a discovered route.");
  const storageState = await discoveryContext.storageState();
  await discoveryContext.close();

  const captures = [];
  const accessibility = [];
  for (const theme of themes) {
    const context = await browser.newContext({ colorScheme: theme, storageState });
    const page = await context.newPage();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      for (const url of routes) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 10_000 }).catch(() => undefined);
        const overflow = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const elements = [...document.querySelectorAll("body *")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.right > viewport + 1 || rect.left < -1 || element.scrollWidth > element.clientWidth + 2;
            })
            .slice(0, 12)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return `${element.tagName.toLowerCase()}.${String(element.className ?? "").split(/\s+/).slice(0, 3).join(".")} [${Math.round(rect.left)}..${Math.round(rect.right)}; ${element.clientWidth}/${element.scrollWidth}]`;
            });
          return { horizontal: document.documentElement.scrollWidth > viewport + 1, elements };
        });
        if (overflow.horizontal) throw new Error(`Route ${new URL(url).pathname} overflows horizontally at ${width}px (${theme}). Elements: ${overflow.elements.join("; ")}`);
        if (width === 1440) {
          const { violations } = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
            .analyze();
          const serious = violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
          accessibility.push({ url, theme, violations: violations.length, serious: serious.length });
          if (serious.length) {
            throw new Error(`Route ${new URL(url).pathname} has ${serious.length} serious accessibility violations (${theme}):\n${serious.map((item) => `${item.id}: ${item.help}\n${item.nodes.map((node) => `  ${node.target.join(" ")}: ${node.failureSummary}`).join("\n")}`).join("\n")}`);
          }
        }
        const routeDir = join(outputDir, routeKey(url));
        mkdirSync(routeDir, { recursive: true });
        const path = join(routeDir, `${width}-${theme}.png`);
        await page.screenshot({ path, fullPage: true });
        captures.push({ url, width, theme, path });
      }
    }
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, routes: routes.length, captureCount: captures.length, accessibility, outputDir, captures }, null, 2));
} finally {
  await browser.close();
}
