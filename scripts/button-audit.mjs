/**
 * Button audit. Signs up a fresh workspace and brand the way the product loop does, then visits each brand screen (and each
 * tab of Studio, Factory and Intelligence) and checks every visible button:
 *
 *   - an enabled button must have a click target (a React pointer handler, or a form submit with a submit handler);
 *   - a disabled button must state its reason in visible text, linked with aria-describedby.
 *
 * It reports every control it checks and every failure. It does not pass by default: any failing control, any screen that
 * did not load, or any screen with no controls makes the run exit 1. Dialogs that open from a button are not opened here;
 * the product loop covers them.
 *
 * Usage: PRODUCT_BASE_URL=http://127.0.0.1:8194 node scripts/button-audit.mjs
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyControl, summarizeRun, summarizeScreen } from "./button-audit-classify.mjs";

const base = process.env.PRODUCT_BASE_URL ?? "http://127.0.0.1:8080";
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "artifacts/e2e");
mkdirSync(artifactDir, { recursive: true });
const reportPath = resolve(artifactDir, "button-audit.json");
const stamp = Date.now();

/** Brand screens. A screen with tabs is visited once per tab, because each tab renders its own buttons. */
const BRAND_SCREENS = [
  { path: "", label: "overview" },
  { path: "/products", label: "products" },
  { path: "/brain", label: "brain" },
  { path: "/market", label: "market" },
  { path: "/opportunities", label: "opportunities" },
  { path: "/studio", label: "studio", tabs: ["1. Direction", "2. Brief", "3. Generate", "4. Review", "5. Queue & schedule"] },
  { path: "/library", label: "library" },
  { path: "/learning", label: "learning" },
  { path: "/reviews", label: "reviews" },
  { path: "/intelligence", label: "intelligence", tabs: ["Account DNA", "Whitespace", "Semantic Memory"] },
  { path: "/calibration", label: "calibration" },
  { path: "/factory", label: "factory", tabs: ["Factory Line", "Discover", "Templates", "Production", "Review", "Live tests", "Learnings"] },
  { path: "/accounts", label: "accounts" },
];

/**
 * Runs in the page. Returns plain facts for each visible button. React attaches its handlers to the DOM node as
 * __reactProps$*, so a button with a handler is told apart from one without.
 */
function collectButtonFacts() {
  const propsOf = (node) => {
    const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
    return key ? node[key] : null;
  };
  const isVisible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll("button, [role='button'], [role='tab'], input[type='submit'], input[type='button']")];
  const facts = [];
  for (const node of nodes) {
    if (!isVisible(node)) continue;
    const props = propsOf(node) ?? {};
    const handlers = Object.keys(props).filter((name) => /^on[A-Z]/.test(name) && typeof props[name] === "function");
    const form = node.form ?? null;
    const formProps = form ? propsOf(form) ?? {} : {};
    const reasonText = (node.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((element) => element && isVisible(element))
      .map((element) => clean(element.textContent))
      .filter(Boolean)
      .join(" ");
    const section = node.closest("section, form, [role='dialog'], article, li, main");
    facts.push({
      name: clean(node.getAttribute("aria-label") || node.textContent || node.getAttribute("title")).slice(0, 100) || "(no name)",
      section: clean(section?.querySelector("h1, h2, h3, h4")?.textContent).slice(0, 80),
      html: node.outerHTML.slice(0, 160),
      visible: true,
      disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
      reasonText,
      isLink: false,
      handlers,
      submitsForm: Boolean(form) && node.type === "submit",
      formHasSubmitHandler: typeof formProps.onSubmit === "function",
    });
  }
  return facts;
}

async function signUpAndCreateBrand(page) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Your name").fill("Audit Fixture");
  await page.getByLabel("Email").fill(`audit-${stamp}@example.com`);
  await page.getByLabel(/^Password/).fill("fixture-pass-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  await page.getByRole("heading", { name: "Name the workspace" }).waitFor({ timeout: 20000 });
  await page.getByLabel("Workspace name").fill(`Audit ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("heading", { name: "Workspace overview" }).waitFor();
  await page.goto(`${base}/brands/new`, { waitUntil: "networkidle" });
  await page.getByLabel("Brand name").fill("Audit Soap");
  await page.getByLabel("What do you sell?").fill("A plain soap bar.");
  await page.getByRole("button", { name: "Create brand" }).click();
  await page.waitForURL((url) => /\/brands\/(?!new$)[^/]+\/?$/.test(url.pathname), { timeout: 20000 });
  return page.url().replace(/\/$/, "");
}

async function auditScreen(page, label, url, tab) {
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    if (tab) await page.getByRole("tab", { name: tab }).click();
    await page.waitForLoadState("networkidle");
    const facts = await page.evaluate(collectButtonFacts);
    const controls = facts.map((fact) => ({ ...fact, ...classifyControl(fact) }));
    return summarizeScreen(label, controls);
  } catch (error) {
    return summarizeScreen(label, [], error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const screens = [];
let fatal = null;
try {
  const brandUrl = await signUpAndCreateBrand(page);
  for (const screen of BRAND_SCREENS) {
    const url = `${brandUrl}${screen.path}`;
    if (!screen.tabs) {
      screens.push(await auditScreen(page, screen.label, url, null));
      continue;
    }
    for (const tab of screen.tabs) {
      screens.push(await auditScreen(page, `${screen.label} · ${tab}`, url, tab));
    }
  }
} catch (error) {
  fatal = error instanceof Error ? error.message.split("\n")[0] : String(error);
} finally {
  await browser.close();
}

const run = summarizeRun(screens);
const report = { ...run, fatal, baseUrl: base, generatedAt: new Date().toISOString() };
writeFileSync(reportPath, JSON.stringify(report, null, 2));
const lines = screens.map((screen) => {
  const counts = screen.counts;
  return `${screen.error ? "ERROR" : "ok   "} ${screen.screen}: ${screen.total} controls, action ${counts.action}, submit ${counts.submit}, disabled with reason ${counts.disabled_reason}, no target ${counts.no_target}, disabled without reason ${counts.disabled_no_reason}${screen.error ? ` (${screen.error})` : ""}`;
});
console.log(lines.join("\n"));
for (const failure of run.failing) {
  console.log(`FAIL ${failure.screen} | ${failure.status} | ${JSON.stringify(failure.name)} | section ${JSON.stringify(failure.section)} | ${failure.html}`);
}
for (const screenError of run.screenErrors) console.log(`FAIL ${screenError.screen} | screen | ${screenError.error}`);
for (const item of run.disabledWithReason) console.log(`reason ${item.screen} | ${JSON.stringify(item.name)} | ${item.reason}`);
if (fatal) console.log(`FAIL setup | ${fatal}`);
console.log(JSON.stringify({ ok: run.ok && !fatal, controlsChecked: run.controlsChecked, failingCount: run.failingCount, report: reportPath }));
process.exitCode = run.ok && !fatal ? 0 : 1;
