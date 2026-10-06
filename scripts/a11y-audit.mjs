import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const base = process.env.A11Y_BASE_URL ?? "http://127.0.0.1:8080";

function serious(results) {
  return results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
}

async function scan(page, name, failures) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = serious(results);
  if (violations.length) {
    failures.push({
      name,
      violations: violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        help: item.help,
        nodes: item.nodes.slice(0, 3).map((node) => node.target.join(" ")),
      })),
    });
  }
}

const browser = await chromium.launch({ headless: true });
const failures = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const stamp = Date.now();

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.keyboard.press("Tab");
const skipFocused = await page.evaluate(() => document.activeElement?.classList.contains("skip-link") ?? false);
if (!skipFocused) failures.push({ name: "skip-link", violations: [{ id: "keyboard", help: "The first tab did not focus the skip link." }] });
await page.keyboard.press("Enter");
const mainFocused = await page.evaluate(() => document.activeElement?.id === "main");
if (!mainFocused) failures.push({ name: "skip-link-target", violations: [{ id: "keyboard", help: "Activating the skip link did not move focus to main." }] });

await page.getByLabel("Your name").fill("A11y Fixture");
await page.getByLabel("Email").fill(`a11y-${stamp}@example.com`);
await page.getByLabel("Password").fill("fixture-pass-1");
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
await page.goto(`${base}/`, { waitUntil: "networkidle" });
const workspaceHeading = page.getByRole("heading", { name: "Name the workspace" });
if (await workspaceHeading.count()) {
  await page.getByLabel("Workspace name").fill(`A11y ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("heading", { name: "What should we make next?" }).waitFor({ timeout: 20000 });
}

for (const route of ["/", "/settings", "/integrations", "/brands/new"]) {
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await scan(page, route, failures);
}

await page.goto(`${base}/brands/new`, { waitUntil: "networkidle" });
const brandForm = page.getByLabel("Brand name");
if ((await brandForm.count()) === 0) {
  const text = await page.locator("body").innerText();
  failures.push({ name: "brand-form", violations: [{ id: "missing-form", help: text.slice(0, 500) }] });
  console.log(JSON.stringify({ base, failures }, null, 2));
  await browser.close();
  process.exit(1);
}
await page.getByLabel("Brand name").fill("North Soap");
await page.getByLabel("What do you sell?").fill("A plain soap bar for people who already buy soap.");
await page.getByRole("button", { name: "Create brand" }).click();
await page.waitForURL(/\/brands\/[^/]+$/, { timeout: 20000 });
const brandUrl = page.url();
const paths = ["", "/brain", "/market", "/intelligence", "/opportunities", "/library", "/reviews", "/learning"];
for (const path of paths) {
  await page.goto(`${brandUrl}${path}`, { waitUntil: "networkidle" });
  await scan(page, new URL(page.url()).pathname, failures);
  const sequence = [];
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press("Tab");
    sequence.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return "none";
      return `${el.tagName}:${el.id}:${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}`;
    }));
  }
  const tail = sequence.slice(-4);
  if (tail.length === 4 && tail.every((item) => item === tail[0]) && !tail[0].startsWith("BODY")) {
    failures.push({ name: `${path || "/brand"} keyboard`, violations: [{ id: "keyboard-trap", help: `Focus stayed on ${tail[0]}.` }] });
  }
}

await page.setViewportSize({ width: 320, height: 800 });
await page.goto(brandUrl, { waitUntil: "networkidle" });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 8) failures.push({ name: "320px", violations: [{ id: "zoom", help: `Horizontal overflow of ${overflow}px.` }] });

await page.setViewportSize({ width: 640, height: 800 });
await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
const overflow200 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow200 > 8) failures.push({ name: "640px", violations: [{ id: "zoom", help: `Horizontal overflow of ${overflow200}px.` }] });

const reducedContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
const reduced = await reducedContext.newPage();
await reduced.goto(`${base}/login`, { waitUntil: "networkidle" });
const motion = await reduced.locator("button").first().evaluate((node) => getComputedStyle(node).transitionDuration);
if (motion !== "0.01ms" && motion !== "1e-05s") failures.push({ name: "reduced-motion", violations: [{ id: "motion", help: `Button transition was ${motion}.` }] });
await reduced.close();
await reducedContext.close();
await context.close();

await browser.close();
const report = { base, failures, checkedAt: new Date().toISOString() };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
