#!/usr/bin/env node
/**
 * The one setup command: `npm run setup`.
 *
 * It checks the Node.js version, installs dependencies only when node_modules is missing, creates .env from .env.example only
 * when .env does not exist, generates TOKEN_ENCRYPTION_KEY only when that line is empty, applies migrations when DATABASE_URL
 * is set (and says plainly when it is not, because the embedded PGlite database applies instead), and prints the next steps.
 *
 * It never prints a secret value. Running it again is safe: an existing .env is never overwritten, and a key that is already
 * set is kept. The pure parts are exported for scripts/setup.test.mjs.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnv } from "./with-dotenv.mjs";

export const MIN_NODE_MAJOR = 22;
export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/** The problem with a Node.js version, or null when it is new enough. The worker runs TypeScript with --experimental-strip-types. */
export function nodeVersionProblem(version) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) return `Could not read the Node.js version "${version}".`;
  if (major < MIN_NODE_MAJOR) {
    return `Node.js ${MIN_NODE_MAJOR} or newer is required. This is Node.js ${version}. Install a current Node.js and run npm run setup again.`;
  }
  return null;
}

/** The .env text to use. An existing file is returned unchanged, so it is never overwritten. Without one, the example is used. */
export function envFileFor(existing, example) {
  if (existing !== null && existing !== undefined) return { text: existing, created: false };
  return { text: example, created: true };
}

/** The value of one variable in an env text, or "" when it is missing or blank. Comments are not values. */
function envValueOf(text, name) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return "";
}

/**
 * Fills one variable that is blank or missing with a value from `makeValue`. A value that is already set is kept, and
 * `makeValue` is not called. Returns the new text and whether it changed.
 */
export function fillBlankEnvValue(text, name, makeValue) {
  if (envValueOf(text, name)) return { text, filled: false };
  const value = makeValue();
  const pattern = new RegExp(`^\\s*${name}\\s*=`);
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    lines[index] = `${name}=${value}`;
    return { text: lines.join("\n"), filled: true };
  }
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return { text: `${text}${separator}${name}=${value}\n`, filled: true };
}

/** A new TOKEN_ENCRYPTION_KEY: 32 random bytes, hex encoded. The caller writes it to .env and never prints it. */
export function generateTokenEncryptionKey(random = randomBytes) {
  return random(32).toString("hex");
}

/**
 * The summary printed at the end. It reads only the named facts below, so no value from .env can reach the output. Each fact
 * is a short state, never a value. `baseUrl` is the public origin, which is not a secret.
 */
export function setupSummary(facts) {
  const database = {
    migrated: "DATABASE_URL is set, and the migrations are applied.",
    failed: "DATABASE_URL is set, but the migrations failed. The error is printed above. Fix it, then run npm run setup again.",
    notSet:
      "DATABASE_URL is not set. Meridian will use the embedded PGlite database, created and migrated on the first start. " +
      "Set DATABASE_URL in .env to use a durable Postgres database.",
  }[facts.database] ?? "The database state was not reported.";
  const baseUrl = facts.baseUrl || DEFAULT_BASE_URL;
  return [
    "Meridian setup",
    `  Node.js:              ${facts.nodeVersion} (${facts.nodeOk ? "ok" : "too old"})`,
    `  Dependencies:         ${facts.dependencies}`,
    `  .env:                 ${facts.envFile}`,
    `  TOKEN_ENCRYPTION_KEY: ${facts.tokenKey} (the value is never printed)`,
    `  Database:             ${database}`,
    "",
    "Next steps",
    "  1. Start the app:          npm run dev   (port 8080)",
    `  2. Sign in:                open ${baseUrl}/login`,
    "  3. Save provider keys:     Settings, General, Setup. Only a workspace admin can save a key.",
    "                             Keys are encrypted, never shown again, and nothing is connected until a key is saved or set on the server.",
    "  4. Background jobs:        npm run worker and npm run scheduler. Both need DATABASE_URL.",
    "  5. Check the code:         npm test",
    "",
    ".env holds local secrets. It is ignored by git. Never commit it.",
  ];
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  const examplePath = join(root, ".env.example");

  const problem = nodeVersionProblem(process.versions.node);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  let dependencies = "already present";
  if (!existsSync(join(root, "node_modules"))) {
    console.log("Installing dependencies with npm ci ...");
    const install = spawnSync("npm", ["ci"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (install.status !== 0) {
      console.error("npm ci failed. Fix the error above, then run npm run setup again.");
      process.exit(1);
    }
    dependencies = "installed now";
  }

  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  if (existing === null && !existsSync(examplePath)) {
    console.error(".env.example is missing, so .env cannot be created.");
    process.exit(1);
  }
  const env = envFileFor(existing, existing === null ? readFileSync(examplePath, "utf8") : "");
  const token = fillBlankEnvValue(env.text, "TOKEN_ENCRYPTION_KEY", () => generateTokenEncryptionKey());
  if (env.created || token.filled) {
    writeFileSync(envPath, token.text, { encoding: "utf8", mode: 0o600 });
  }

  // The migrator reads DATABASE_URL from the environment, so the .env values are applied to this process first. A variable
  // already set in the shell wins, as it does for every other command.
  applyEnv(token.text);
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  let database = "notSet";
  if (databaseUrl) {
    console.log("Applying database migrations ...");
    const migrate = spawnSync(process.execPath, [join(root, "scripts", "migrate.mjs")], { cwd: root, stdio: "inherit", env: process.env });
    database = migrate.status === 0 ? "migrated" : "failed";
  }

  const summary = setupSummary({
    nodeVersion: process.versions.node,
    nodeOk: true,
    dependencies,
    envFile: env.created ? "created from .env.example" : "kept as it was",
    tokenKey: token.filled ? "generated" : "already set",
    database,
    baseUrl: process.env.BETTER_AUTH_URL?.trim() || DEFAULT_BASE_URL,
  });
  console.log(`\n${summary.join("\n")}`);
  process.exit(database === "failed" ? 1 : 0);
}

if (isDirectRun()) main();
