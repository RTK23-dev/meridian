#!/usr/bin/env node
/**
 * Runs the vendored Agent Reach tool (vendor/agent-reach) as an operator tool, outside the Meridian app.
 *
 * It is read-only by default: `install` only checks the host. Changing the host needs two explicit flags, --system and
 * --approve-system, and the --dry-run output should be read first. Only `install` and `doctor` run through this wrapper.
 * Proxy settings and cookie or login commands are not allowed here: the operator configures those on the host directly,
 * and Meridian never reads them. See docs/AGENT_REACH.md.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const VENDOR_DIR = resolve(fileURLToPath(new URL("../vendor/agent-reach", import.meta.url)));
const COMMANDS = new Set(["install", "doctor"]);
/** The upstream package has no __main__ module, so it is started through its own entry point. */
const PYTHON_ENTRY = ["-c", "from agent_reach.cli import main; main()"];
const INSTALL_FLAGS = new Set(["--system", "--approve-system", "--dry-run", "--safe"]);
const INSTALL_VALUE_FLAGS = ["--env=", "--channels="];
const DOCTOR_FLAGS = new Set(["--json"]);

/**
 * The upstream arguments for one wrapper call, or an error that says what to do instead. The wrapper's own flag,
 * --approve-system, is removed before the upstream tool sees the arguments.
 */
export function buildAgentReachArgs(argv) {
  const [command = "install", ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error(`"${command}" does not run through this wrapper. Read docs/AGENT_REACH.md and run it on the host yourself.`);
  }
  if (command === "doctor") {
    for (const flag of rest) {
      if (!DOCTOR_FLAGS.has(flag)) throw new Error(`Unknown option for doctor: ${flag}.`);
    }
    return [...PYTHON_ENTRY, "doctor", ...rest];
  }

  const system = rest.includes("--system");
  const approved = rest.includes("--approve-system");
  if (system && !approved) {
    throw new Error("--system changes this machine. Read the --dry-run output, then add --approve-system to confirm.");
  }
  if (approved && !system) throw new Error("--approve-system only applies together with --system.");

  const upstream = [...PYTHON_ENTRY, "install"];
  let hasEnv = false;
  for (const flag of rest) {
    if (flag === "--approve-system") continue;
    if (INSTALL_FLAGS.has(flag)) {
      upstream.push(flag);
      continue;
    }
    if (INSTALL_VALUE_FLAGS.some((prefix) => flag.startsWith(prefix))) {
      if (flag.startsWith("--env=")) hasEnv = true;
      upstream.push(flag);
      continue;
    }
    throw new Error(`Unknown or unsupported option for install: ${flag}. Proxy and cookie settings are configured on the host, not here.`);
  }
  if (!hasEnv) upstream.push("--env=auto");
  return upstream;
}

function main(argv) {
  let args;
  try {
    args = buildAgentReachArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const result = spawnSync("python3", args, {
    cwd: VENDOR_DIR,
    env: { ...process.env, PYTHONPATH: VENDOR_DIR },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not start python3: ${result.error.message}. Agent Reach needs Python 3.10 or newer.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
