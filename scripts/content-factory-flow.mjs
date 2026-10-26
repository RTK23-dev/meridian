// Browser flow for the Content page (review phase 4). It signs in with an account from the environment, checks that the page
// tells the truth about what is connected, creates a session, and checks that planning is refused rather than shown as done. It writes a
// screenshot of each step. Nothing here calls a provider: the flow stops at the honest states the page shows without keys.
//
//   MERIDIAN_SMOKE_EMAIL=... MERIDIAN_SMOKE_PASSWORD=... node scripts/content-factory-flow.mjs
//   optional: MERIDIAN_SMOKE_URL (default http://localhost:8080), MERIDIAN_SMOKE_OUT (default test-results/content-factory),
//             MERIDIAN_SMOKE_CHROMIUM (an installed Chromium binary)
//
// Exit 0 when every check passes, 1 when one does not. The account must exist on the server it runs against.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";
import { settleAnimations } from "./page-settle.mjs";

const base = checkedUrl(process.env.MERIDIAN_SMOKE_URL ?? "http://localhost:8080");
const email = process.env.MERIDIAN_SMOKE_EMAIL ?? "";
const password = process.env.MERIDIAN_SMOKE_PASSWORD ?? "";
if (!email || !password) {
  console.error("MERIDIAN_SMOKE_EMAIL and MERIDIAN_SMOKE_PASSWORD must be set. Nothing was run.");
  process.exit(1);
}
const outDir = checkedOutputPath(resolve(process.env.MERIDIAN_SMOKE_OUT ?? "test-results/content-factory"), [resolve("test-results")], "output");
mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// MERIDIAN_SMOKE_CHROMIUM names an installed Chromium; unset, Playwright uses its own browser.
const browser = await chromium.launch({ headless: true, executablePath: process.env.MERIDIAN_SMOKE_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${base}/login`, { waitUntil: "networkidle", timeout: 90000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").first().fill(password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  check("signs in", !new URL(page.url()).pathname.startsWith("/login"), page.url());

  await page.goto(`${base}/content-factory`, { waitUntil: "networkidle", timeout: 90000 });
  await settleAnimations(page);
  // The planner and the model panel sit behind a disclosure. Open it once here, so the page text and the Plan the run button below
  // are both visible. Clicking it again would close it.
  const disclosure = page.getByText("Plan a run in detail", { exact: false }).first();
  if ((await disclosure.count()) > 0) await disclosure.click();
  const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("shows the Content page", main.includes("Make, review, publish and learn"));
  await page.screenshot({ path: checkedOutputPath(resolve(outDir, "01-page.png"), [outDir], "screenshot") });

  // The page must not say the live catalog is connected when no key is saved. The words it uses for the absent key are the check.
  const honest = main.includes("NOT CONNECTED") || main.includes("No model is stored");
  check("says what is not connected", honest);

  const create = page.getByRole("button", { name: "Create session", exact: true });
  const createCount = await create.count();
  check("offers Create session", createCount > 0);
  if (createCount > 0) {
    if (await create.isDisabled()) {
      // Without a brand a session cannot start, and the page says so. That is the honest state; the flow stops there.
      check("Create session is disabled, and the page says why", /brand/i.test(main), "no brand is set up in this workspace");
    } else {
      await create.click();
      await page.waitForTimeout(2500);
      await settleAnimations(page);
      await page.screenshot({ path: checkedOutputPath(resolve(outDir, "02-session.png"), [outDir], "screenshot") });
      const after = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      check("a session is created without a server error", !after.toLowerCase().includes("something went wrong"));
    }
  }

  const plan = page.getByRole("button", { name: "Plan the run", exact: true });
  if ((await plan.count()) > 0) {
    const disabled = await plan.isDisabled();
    if (!disabled) {
      await plan.click();
      await page.waitForTimeout(2500);
    }
    const planned = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    // A plan without a stored model, or without a live key, is refused. Its page must not claim a plan was written or priced.
    check("planning is refused without a model, not shown as done", disabled || !/plan (is )?(ready|written)/i.test(planned), disabled ? "button disabled" : "refused on the page");
    await page.screenshot({ path: checkedOutputPath(resolve(outDir, "03-plan.png"), [outDir], "screenshot") });
  }
} catch (error) {
  check("the flow ran to the end", false, error instanceof Error ? error.message : "unknown error");
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.passed);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.map((item) => item.name) }));
process.exit(failed.length === 0 ? 0 : 1);
