/**
 * Button audit. Signs up a fresh workspace and brand the way the product loop does, then visits each brand screen (and each
 * tab of Studio, Factory and Intelligence) and checks every visible button:
 *
 *   - an enabled button must have a click target (a React pointer handler, or a form submit with a submit handler);
 *   - a disabled button must state its reason in visible text, linked with aria-describedby.
 *
 * It also opens each dialog that a visible, enabled, non-submit control declares it opens (aria-haspopup="dialog"; Radix
 * triggers set this). For each one it checks the dialog has a title and a Cancel or Close control, and closes it with that
 * control. The audit never clicks a control to find out whether it opens a dialog, so a dialog opened only by plain state
 * is not counted here. The product loop covers those.
 *
 * It reports every control and dialog it checks and every failure. It does not pass by default: any failing control, any
 * failing dialog, any screen that did not load, or any screen with no controls makes the run exit 1.
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
  // The login page opens in sign-in mode. The audit makes a new account, so it switches to sign-up first.
  const createInstead = page.getByRole("button", { name: "Create an account instead" });
  if (await createInstead.isVisible()) await createInstead.click();
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

/** Dialog openers the audit can name without clicking: the controls that declare aria-haspopup="dialog". */
const OPENER_SELECTOR = "button[aria-haspopup='dialog'], [role='button'][aria-haspopup='dialog']";
const DIALOG_SELECTOR = "[role='dialog'], [role='alertdialog']";
const CLOSER_NAME = /\b(cancel|close)\b/i;
const DIALOG_TIMEOUT_MS = 3000;
const MAX_DIALOGS_PER_SCREEN = 8;

/**
 * Runs in the page. The declared dialog openers that are visible and enabled. A submit control is left out, because a click on
 * it sends its form. `index` is the position in OPENER_SELECTOR, so the audit can locate the same control again.
 */
function collectOpenerFacts() {
  const isVisible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll("button[aria-haspopup='dialog'], [role='button'][aria-haspopup='dialog']")];
  return nodes
    .map((node, index) => ({
      index,
      name: clean(node.getAttribute("aria-label") || node.textContent).slice(0, 100) || "(no name)",
      visible: isVisible(node),
      disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
      submits: node.type === "submit" && node.form !== null,
    }))
    .filter((item) => item.visible && !item.disabled && !item.submits);
}

/** Runs on the open dialog. Its accessible title, and whether it has a Cancel or Close control. */
function dialogFacts(node) {
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const labelledBy = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).find(Boolean);
  const labelled = labelledBy ? clean(document.getElementById(labelledBy)?.textContent) : "";
  const title = labelled || clean(node.getAttribute("aria-label")) || clean(node.querySelector("h1, h2, h3")?.textContent);
  const closers = [...node.querySelectorAll("button, [role='button']")]
    .map((element) => clean(element.getAttribute("aria-label") || element.textContent))
    .filter((name) => /\b(cancel|close)\b/i.test(name));
  return { title, closers };
}

/**
 * Opens each declared dialog opener on the current screen, checks the dialog has a title and a Cancel or Close control, and
 * closes it with that control. Each dialog is bounded to a few seconds. A dialog that does not open, has no title, or does not
 * close is a failure. Returns one result per dialog.
 */
async function checkDialogs(page, screenLabel, screenUrl) {
  const openers = (await page.evaluate(collectOpenerFacts)).slice(0, MAX_DIALOGS_PER_SCREEN);
  const results = [];
  for (const opener of openers) {
    const result = { screen: screenLabel, name: opener.name, opened: false, title: "", closers: 0, closed: false, problems: [] };
    try {
      await page.locator(OPENER_SELECTOR).nth(opener.index).click({ timeout: DIALOG_TIMEOUT_MS });
      const dialog = page.locator(DIALOG_SELECTOR).filter({ visible: true }).last();
      try {
        await dialog.waitFor({ state: "visible", timeout: DIALOG_TIMEOUT_MS });
      } catch {
        result.problems.push(`no dialog opened within ${DIALOG_TIMEOUT_MS / 1000} s`);
        throw new Error("no dialog");
      }
      result.opened = true;
      const facts = await dialog.evaluate(dialogFacts);
      result.title = facts.title;
      result.closers = facts.closers.length;
      if (!facts.title) result.problems.push("the dialog has no title");
      if (facts.closers.length === 0) result.problems.push("the dialog has no Cancel or Close control");
      if (facts.closers.length > 0) {
        await dialog.getByRole("button", { name: CLOSER_NAME }).first().click({ timeout: DIALOG_TIMEOUT_MS });
      } else {
        await page.keyboard.press("Escape");
      }
      await dialog.waitFor({ state: "hidden", timeout: DIALOG_TIMEOUT_MS });
      result.closed = true;
    } catch (error) {
      if (result.problems.length === 0) result.problems.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
      await page.keyboard.press("Escape").catch(() => {});
    }
    // A control that navigates away is not a dialog. Return to the screen so the next dialog is checked where it belongs.
    if (new URL(page.url()).pathname !== new URL(screenUrl).pathname) {
      await page.goto(screenUrl, { waitUntil: "networkidle" });
    }
    results.push({ ...result, ok: result.opened && result.closed && result.problems.length === 0 });
  }
  return results;
}

async function auditScreen(page, label, url, tab, dialogs) {
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    if (tab) await page.getByRole("tab", { name: tab }).click();
    await page.waitForLoadState("networkidle");
    const facts = await page.evaluate(collectButtonFacts);
    const controls = facts.map((fact) => ({ ...fact, ...classifyControl(fact) }));
    const screen = summarizeScreen(label, controls);
    try {
      dialogs.push(...await checkDialogs(page, label, url));
    } catch (error) {
      dialogs.push({ screen: label, name: "(dialogs)", opened: false, title: "", closers: 0, closed: false, ok: false, problems: [`the dialogs could not be checked: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`] });
    }
    return screen;
  } catch (error) {
    return summarizeScreen(label, [], error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const screens = [];
const dialogs = [];
let fatal = null;
try {
  const brandUrl = await signUpAndCreateBrand(page);
  for (const screen of BRAND_SCREENS) {
    const url = `${brandUrl}${screen.path}`;
    if (!screen.tabs) {
      screens.push(await auditScreen(page, screen.label, url, null, dialogs));
      continue;
    }
    for (const tab of screen.tabs) {
      screens.push(await auditScreen(page, `${screen.label} · ${tab}`, url, tab, dialogs));
    }
  }
} catch (error) {
  fatal = error instanceof Error ? error.message.split("\n")[0] : String(error);
} finally {
  await browser.close();
}

const run = summarizeRun(screens);
const dialogsFailing = dialogs.filter((dialog) => !dialog.ok);
const dialogsOpened = dialogs.filter((dialog) => dialog.opened).length;
const report = { ...run, dialogs, dialogsChecked: dialogs.length, dialogsOpened, dialogsFailing: dialogsFailing.length, fatal, baseUrl: base, generatedAt: new Date().toISOString() };
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
for (const dialog of dialogs) {
  const detail = dialog.ok
    ? `title ${JSON.stringify(dialog.title)}, Cancel or Close ${dialog.closers > 0 ? "present" : "missing"}, closed`
    : dialog.problems.join("; ");
  console.log(`${dialog.ok ? "dialog ok  " : "FAIL dialog"} ${dialog.screen} | ${JSON.stringify(dialog.name)} | ${detail}`);
}
if (fatal) console.log(`FAIL setup | ${fatal}`);
console.log(`dialogs checked ${dialogs.length}, opened ${dialogsOpened}, failing ${dialogsFailing.length}`);
console.log(JSON.stringify({
  ok: run.ok && !fatal && dialogsFailing.length === 0,
  controlsChecked: run.controlsChecked,
  failingCount: run.failingCount,
  dialogsChecked: dialogs.length,
  dialogsOpened,
  dialogsFailing: dialogsFailing.length,
  report: reportPath,
}));
process.exitCode = run.ok && !fatal && dialogsFailing.length === 0 ? 0 : 1;
