#!/usr/bin/env node
/**
 * `npm run dev`: the one command for a local trial.
 *
 *   1. First start: when .env or node_modules is missing, runs `npm run setup` (scripts/setup.mjs) with --from-dev, so setup
 *      does not print its own next steps. Setup creates .env and generates the two secrets.
 *   2. Loads .env into this process. A variable already set in the shell wins, and a blank value is ignored (as with-dotenv.mjs).
 *   3. Without DATABASE_URL, the embedded database is kept on disk in .data/pglite (MERIDIAN_LOCAL_DATA_DIR, set here unless a
 *      value is given). The Vite dev server then runs the queued jobs itself (vite.config.ts, localJobsPlugin). With
 *      DATABASE_URL, the jobs need `npm run worker` and `npm run scheduler`, as before.
 *   4. Starts the Vite dev server through scripts/with-app-env.mjs on port 8080, unless --port or --host is given. Signals are
 *      forwarded to it, and its exit status becomes this script's exit status.
 *   5. Once the server answers, prints what is running. On a first start it also prints three steps.
 *
 * Loading .env here matters: the dev server reads BETTER_AUTH_SECRET and TOKEN_ENCRYPTION_KEY from the environment, so without
 * this a restart signs everyone out and a saved provider key cannot be opened.
 *
 * The pure parts are exported for scripts/dev.test.mjs.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnv } from "./with-dotenv.mjs";
import { exitStatusFromChild, isMainModule } from "./with-app-env.mjs";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8080;
/** Where the embedded database is kept for a local trial, relative to the project root. */
export const LOCAL_DATA_RELATIVE_PATH = join(".data", "pglite");
const READY_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 60_000;

function hasFlag(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** The port the server listens on: the value after --port (or --port=), else 8080. */
export function portFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value;
    if (arg === "--port") value = args[index + 1];
    else if (arg.startsWith("--port=")) value = arg.slice("--port=".length);
    else continue;
    const port = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

/** The arguments for `vite`: the dev command, with this script's host and port unless the caller gives its own. */
export function viteArgs(args) {
  const out = ["dev"];
  if (!hasFlag(args, "--host")) out.push("--host", DEFAULT_HOST);
  if (!hasFlag(args, "--port")) out.push("--port", String(DEFAULT_PORT));
  return [...out, ...args];
}

/** True when DATABASE_URL is unset or blank, so the embedded database and the local job loop are used. */
export function isLocalDatabase(databaseUrl) {
  return !(databaseUrl ?? "").trim();
}

/** Setup runs when .env or node_modules is missing. A start without either cannot reach the server. */
export function needsSetup({ envFileExisted, nodeModulesExist }) {
  return !envFileExisted || !nodeModulesExist;
}

/**
 * Whether this start is a first start: .env was just created, or the local database folder does not exist yet.
 * Pure, so the rule is tested.
 */
export function isFirstStart({ envFileExisted, localDatabase, dataDirExisted }) {
  return !envFileExisted || (localDatabase && !dataDirExisted);
}

/**
 * The lines printed once the server answers. The status lines say where the database is and whether jobs run in this process.
 * A first start adds the three steps after them.
 */
export function announceLines({ origin, localDatabase, dataDir, firstStart }) {
  const status = [
    `Meridian is running at ${origin}. Stop it with Ctrl+C.`,
    localDatabase
      ? `  Database: the embedded database in ${dataDir}. It is kept between restarts.`
      : "  Database: DATABASE_URL, a Postgres database.",
    localDatabase
      ? "  Jobs: the queued jobs run in this dev server, so no worker process is needed."
      : "  Jobs: this server does not run them. Start npm run worker and npm run scheduler.",
  ];
  if (!firstStart) return status;
  return [
    ...status,
    "",
    "Three steps to a working brand:",
    `  1. Open ${origin} in a browser.`,
    '  2. Create an account. On the sign-in page, choose "Create an account instead".',
    "  3. Create a workspace, then a brand, and complete the brand brain.",
  ];
}

/**
 * True when the server answers its liveness route (it does not read the database). The request is not aborted while the server
 * is still compiling: an aborted request is logged by the server as an error. Only a refused connection counts as not ready.
 */
function probe(url) {
  return new Promise((resolve) => {
    let bound;
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      resolve(ready);
    };
    // agent: false opens a connection for this one request, which closes after its response, so no socket is left half used.
    const request = http.get(url, { agent: false }, (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.on("error", () => finish(false));
    // A server that accepts the connection and never answers is not ready. This bound is far longer than a first compile.
    bound = setTimeout(() => {
      request.destroy();
      finish(false);
    }, PROBE_TIMEOUT_MS);
  });
}

async function announceWhenReady(origin, lines) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(`${origin}/api/health`)) {
      for (const line of lines) console.log(line);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(
    `Meridian has not answered at ${origin} after three minutes. The log above says why.`,
  );
}

function main(args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  const envFileExisted = existsSync(envPath);
  const nodeModulesExist = existsSync(join(root, "node_modules"));

  if (needsSetup({ envFileExisted, nodeModulesExist })) {
    const setup = spawnSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--from-dev"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (setup.status !== 0) {
      console.error(
        "npm run setup did not finish. Fix the error above, then run npm run dev again.",
      );
      process.exit(setup.status ?? 1);
    }
  }

  // Shell values win over .env, and blank .env values are ignored, so an explicit export always works.
  if (existsSync(envPath)) applyEnv(readFileSync(envPath, "utf8"));

  const databaseUrl = process.env.DATABASE_URL;
  const localDatabase = isLocalDatabase(databaseUrl);
  if (localDatabase && !process.env.MERIDIAN_LOCAL_DATA_DIR?.trim()) {
    process.env.MERIDIAN_LOCAL_DATA_DIR = join(root, LOCAL_DATA_RELATIVE_PATH);
  }
  const dataDir = process.env.MERIDIAN_LOCAL_DATA_DIR?.trim() ?? "";
  // Checked before the server starts, because the database creates the folder on its first start.
  const firstStart = isFirstStart({
    envFileExisted,
    localDatabase,
    dataDirExisted: dataDir ? existsSync(dataDir) : false,
  });

  const child = spawn(
    process.execPath,
    [join(root, "scripts", "with-app-env.mjs"), "vite", ...viteArgs(args)],
    {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`[dev] Could not start the dev server: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(exitStatusFromChild(code, signal));
  });

  const origin = `http://127.0.0.1:${portFromArgs(args)}`;
  void announceWhenReady(origin, announceLines({ origin, localDatabase, dataDir, firstStart }));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
