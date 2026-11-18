// The first-video walkthrough: what a new, non-technical person does to get a free video, timed step by step.
// It signs up, names a workspace, creates a brand, opens Create, picks "Free, with Claude Code on your computer", connects this computer,
// asks for a video from an idea, and checks the request shows as Waiting in the card. Nothing is rendered and no provider is called: the
// request waits for a runner, which this walkthrough does not start. It fails when any step fails, when the whole run takes over 10
// minutes of wall time, or when the page logs an uncaught error.
//
// Run it against a dev server in the testing runtime (a fresh MERIDIAN_LOCAL_DATA_DIR is best):
//   PRODUCT_BASE_URL=http://127.0.0.1:8080 npm run e2e:first-video
// Optional: FIRST_VIDEO_OUT (default artifacts/first-video-walkthrough) for the report and a screenshot of each step;
//           MERIDIAN_SMOKE_CHROMIUM names an installed Chromium when Playwright's own download is not present.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { WALKTHROUGH_LIMIT_MS, stepTimer, walkthroughAccount, walkthroughBase, walkthroughReport, walkthroughVerdict } from "./first-video-walkthrough-lib.mjs";

const base = walkthroughBase(process.env.PRODUCT_BASE_URL ?? "http://127.0.0.1:8080");
const out = process.env.FIRST_VIDEO_OUT ?? "artifacts/first-video-walkthrough";
mkdirSync(out, { recursive: true });

const STEPS = ["sign up", "name the workspace", "create a brand", "open Create", "pick Claude Code", "connect this computer", "ask for a video", "request shows Waiting"];
const account = walkthroughAccount();
const timer = stepTimer();
const pageErrors = [];
const consoleErrors = [];

// The wall-time limit holds even if a browser call hangs: past it, the run is reported and ends.
const watchdog = setTimeout(() => {
  finish(new Error(`The walkthrough did not finish within ${WALKTHROUGH_LIMIT_MS / 60000} minutes.`)).finally(() => process.exit(1));
}, WALKTHROUGH_LIMIT_MS + 5_000);

let browser = null;
let page = null;
let finished = false;

async function finish(failure) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (failure && page) await page.screenshot({ path: join(out, "failure.png"), fullPage: true, mask: [page.locator("code")] }).catch(() => undefined);
  const totalMs = timer.elapsed();
  const verdict = walkthroughVerdict({ steps: timer.steps, expected: STEPS, totalMs, pageErrors });
  if (failure && verdict.pass) {
    verdict.reasons.push(failure.message);
    verdict.pass = false;
  }
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ base, steps: timer.steps, totalMs, pageErrors, consoleErrors, verdict }, null, 2)}\n`);
  console.log(walkthroughReport({ steps: timer.steps, totalMs, verdict }));
  if (consoleErrors.length > 0) console.log(`Console errors (reported, not failing): ${consoleErrors.length}. See ${join(out, "report.json")}.`);
  await browser?.close().catch(() => undefined);
  process.exitCode = verdict.pass ? 0 : 1;
}

// Every code element is masked: the connect command carries the connector link's secret, which never goes into an artifact.
async function shot(name) {
  await page.screenshot({ path: join(out, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`), mask: [page.locator("code")] }).catch(() => undefined);
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.MERIDIAN_SMOKE_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // The card copies the commands it shows. Granting the clipboard keeps that from failing; the copy is not needed for any check.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base }).catch(() => undefined);
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`.slice(0, 300)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });

  await timer.run("sign up", async () => {
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Create an account instead" }).click();
    await page.getByLabel("Your name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"));
  });

  await timer.run("name the workspace", async () => {
    await page.getByRole("heading", { name: "Name the workspace" }).waitFor();
    await page.getByLabel("Workspace name").fill(account.workspace);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByRole("heading", { name: "Workspace overview" }).waitFor();
  });

  await timer.run("create a brand", async () => {
    await page.goto(`${base}/brands/new`, { waitUntil: "networkidle" });
    await page.getByLabel("Brand name").fill(account.brand);
    await page.getByLabel("What do you sell?").fill("Reusable water bottles");
    await page.getByRole("button", { name: "Create brand" }).click();
    await page.waitForURL((url) => /\/brands\/(?!new$)[^/]+\/?$/.test(url.pathname));
  });

  await timer.run("open Create", async () => {
    // Create is in the sidebar for every workspace, so the person clicks it as they would.
    await page.getByRole("link", { name: "Create", exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === "/create");
    await page.getByRole("group", { name: "How do you want to make it?" }).waitFor();
    await shot("open-create");
  });

  const card = page.locator('section[aria-labelledby="claude-code-video-title"]');
  await timer.run("pick Claude Code", async () => {
    await page.getByRole("radio", { name: /Free, with Claude Code on your computer/ }).check();
    await card.getByRole("heading", { name: "Make a video with Claude Code" }).waitFor();
  });

  await timer.run("connect this computer", async () => {
    await card.getByRole("button", { name: "Connect this computer" }).click();
    // The one command to run on the computer is shown once. Running it is the person's step; this run stops at the command.
    await card.getByText(/Run this in a terminal, in the Meridian folder/).waitFor();
    // The command names this server's connector link; its secret is never printed or saved by this run.
    const commands = await card.locator("code").filter({ hasText: "/api/mcp/" }).count();
    if (commands !== 1) throw new Error("The connect command does not name a connector link.");
    await shot("connect-this-computer");
  });

  await timer.run("ask for a video", async () => {
    await card.getByLabel("Which brand is it for?").selectOption({ label: account.brand });
    await card.getByLabel("The idea").fill("A 20-second video on why a reusable bottle saves money in a month");
    await card.getByRole("button", { name: "Generate with Claude Code" }).click();
  });

  await timer.run("request shows Waiting", async () => {
    const requests = card.getByRole("list", { name: "Recent requests" });
    await requests.getByText("Waiting", { exact: true }).first().waitFor({ timeout: 30_000 });
    await shot("request-waiting");
  });

  await finish(null);
} catch (error) {
  await finish(error instanceof Error ? error : new Error(String(error)));
}
