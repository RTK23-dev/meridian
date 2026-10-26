// Runs the release browser acceptance end to end, the same way in CI and on a developer's machine:
//   1. starts the dev server in the testing runtime on a fresh embedded database, and creates the owner account and workspace through
//      the sign-up form;
//   2. stops the server, seeds two uncertain holds into that database, and starts the server again;
//   3. runs the browser checks (acceptance.mjs);
//   4. stops the server, and checks the database for the audited release (verify-release.mjs).
// It sends no provider request. The server is stopped on every exit path, and each step has a time limit.
// Run it from the repository root: node scripts/release-acceptance/run.mjs

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { localAcceptanceBase } from "./local-base.mjs";

const base = localAcceptanceBase(process.env.ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8080");
const email = process.env.ACCEPTANCE_EMAIL ?? "acceptance-owner@example.com";
const password = process.env.ACCEPTANCE_PASSWORD ?? "AcceptancePass-1";
const out = process.env.ACCEPTANCE_OUT ?? "artifacts/release-acceptance";
const STEP_MS = 300_000;
const SERVER_MS = 240_000;

mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "meridian-acceptance-"));
const serverLog = createWriteStream(join(out, "dev-server.log"));
let server = null;

/** Starts the dev server in the testing runtime, on this run's data directory. The server is its own process group, so it stops whole. */
function startServer() {
  server = spawn("npm", ["run", "dev"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MERIDIAN_TESTING_RUNTIME: "true", MERIDIAN_LOCAL_DATA_DIR: dataDir },
  });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
}

async function stopServer() {
  if (!server) return;
  const current = server;
  server = null;
  try {
    process.kill(-current.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-current.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
      resolve();
    }, 15_000);
    current.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Resolves once the app answers on its base URL. Rejects if the server exits first, or when the time limit passes. */
async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < SERVER_MS) {
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The dev server did not answer at ${base} within ${SERVER_MS / 1000} seconds.`);
}

/** Runs one command in the repository, and resolves with its exit code. A script runs with this node. */
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} did not finish within ${STEP_MS / 1000} seconds.`));
    }, STEP_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Creates the owner account and the workspace through the sign-up form, the way a person does. */
async function createOwnerAccount() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Create an account instead" }).click();
    await page.getByLabel("Your name").fill("Acceptance Owner");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(/^Password/).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"));
    await page.getByRole("heading", { name: "Name the workspace" }).waitFor();
    await page.getByLabel("Workspace name").fill("Acceptance workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByRole("heading", { name: "Workspace overview" }).waitFor();
  } finally {
    await browser.close();
  }
}

let exitCode = 1;
try {
  // The first start in a fresh checkout pre-bundles the app, as the end-to-end job does, so the first page does not stall.
  const optimized = await run("npx", ["vite", "optimize"]);
  if (optimized !== 0) throw new Error("vite optimize failed before the dev server started.");
  startServer();
  await waitForServer();
  await createOwnerAccount();
  await stopServer();
  const seeded = await run(process.execPath, ["scripts/release-acceptance/seed-holds.mjs", dataDir]);
  if (seeded !== 0) throw new Error("Seeding the uncertain holds failed.");
  startServer();
  await waitForServer();
  const acceptance = await run(process.execPath, ["scripts/release-acceptance/acceptance.mjs"], { ACCEPTANCE_OUT: out });
  await stopServer();
  const verified = await run(process.execPath, ["scripts/release-acceptance/verify-release.mjs", dataDir]);
  exitCode = acceptance !== 0 ? acceptance : verified;
} catch (error) {
  console.error(`RELEASE ACCEPTANCE STOPPED: ${error.message}`);
} finally {
  await stopServer();
  serverLog.end();
}
process.exitCode = exitCode;
