#!/usr/bin/env node
/**
 * The Claude Code runner. Run it on your own computer, in the Meridian folder:
 *
 *   npm run claude:runner -- <the link Meridian shows>     (the first time: the link is saved for next time)
 *   npm run claude:runner                                   (after that)
 *   npm run claude:runner -- --keep-sessions                (also save each job as a Claude Code conversation, for debugging)
 *   npm run claude:runner -- --sandbox                      (run Claude Code inside bubblewrap or sandbox-exec; refuses to start without one)
 *   npm run claude:runner -- --install [--now]              (start with the computer, and again if it stops; --now also turns it on)
 *   npm run claude:runner -- --uninstall                    (remove that again)
 *
 * It waits for videos you ask for in Meridian (Create, "Free, with Claude Code on your computer"). For each one it starts a fresh
 * Claude Code session with the model you chose, lets it make and upload the video, and tells Meridian how it ended. It uses your own
 * Claude Code sign-in and calls no paid provider. Stop it with Ctrl+C: a job it was making is queued again.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedLink, childEnv, claudeArgs, HEARTBEAT_MS, isResultLine, JOB_TIMEOUT_MS, logsToDelete, mcpConfig, POLL_MS, progressLabel, readEnd, redact,
  sandboxPlan, serviceFile, shownCommand, spawnGroupOptions, splitLines, treeKill, versionOf,
} from "./claude-code-runner-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.MERIDIAN_RUNNER_HOME || join(root, ".meridian");
const configPath = join(home, "runner.json");
const claudeBin = process.env.CLAUDE_BIN || "claude";
const once = process.argv.includes("--once");
// Off by default: a saved conversation per video would fill your Claude Code history. Turn it on to look into a job with `claude --resume`.
const keepSession = process.argv.includes("--keep-sessions");
const runnerName = (process.env.MERIDIAN_RUNNER_NAME || hostname() || "runner").slice(0, 120);
const sandbox = process.argv.includes("--sandbox");
const install = process.argv.includes("--install");
const uninstall = process.argv.includes("--uninstall");
const installNow = process.argv.includes("--now");
// The operating system's own program search path, handed to the service so it finds claude, ffmpeg and ffprobe as this terminal does.
// It is not a Meridian setting.
const { PATH: searchPath = "" } = process.env;
/** A label is sent early when it changes, but not more often than this. */
const PROGRESS_MIN_MS = 10_000;

const say = (line) => console.log(`[runner] ${line}`);

/** Finds a program on the PATH, or null. Used for the sandbox programs, which are looked for, never assumed. */
function onPath(program) {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [program], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim().split("\n")[0] : null;
}

/** --install and --uninstall: writes or removes the per-user service, prints how to turn it on, and turns it on only with --now. */
function manageService() {
  let service;
  try {
    service = serviceFile({
      platform: process.platform,
      home: homedir(),
      nodePath: process.execPath,
      repoDir: root,
      scriptPath: fileURLToPath(import.meta.url),
      searchPath,
      flags: [sandbox ? "--sandbox" : null, keepSession ? "--keep-sessions" : null].filter(Boolean),
    });
  } catch (error) {
    say(error.message);
    process.exit(2);
  }
  const run = (words) => {
    say(`$ ${shownCommand(words)}`);
    const done = spawnSync(words[0], words.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    if (done.status !== 0) say(`That did not work (${done.error?.message ?? `exit ${done.status}`}). Run it yourself.`);
  };
  if (uninstall) {
    // Removing is always safe to do for the person: the service is stopped first, then its file is deleted.
    if (existsSync(service.file)) for (const words of service.disable) run(words);
    rmSync(service.file, { force: true });
    say(`Removed ${service.file}. The runner no longer starts with the computer.`);
    process.exit(0);
  }
  if (!existsSync(configPath)) {
    say("Save the link first: run the command Meridian showed (npm run claude:runner -- <link>) once, or add the link to this command.");
    process.exit(2);
  }
  mkdirSync(dirname(service.file), { recursive: true });
  writeFileSync(service.file, service.content, { mode: 0o644 });
  say(`Wrote ${service.file}. It holds no link: the runner reads that from .meridian/runner.json.`);
  if (installNow) {
    for (const words of service.enable) run(words);
  } else {
    say("Turn it on with:");
    for (const words of service.enable) say(`  ${shownCommand(words)}`);
    say("Or run this again with --install --now to do it for you.");
  }
  if (process.platform === "linux") say("To keep it running while you are signed out, also run: loginctl enable-linger \"$USER\"");
  process.exit(0);
}

if (uninstall) manageService();

function loadLink() {
  const given = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (given) {
    const checked = checkedLink(given);
    if (!checked.ok) {
      say(checked.reason);
      process.exit(2);
    }
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ link: checked.link }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    say("Link saved for next time (in .meridian/runner.json, which git ignores). Keep it private.");
    return checked.link;
  }
  if (!existsSync(configPath)) {
    say("No link is saved yet. Open Create in Meridian, choose \"Free, with Claude Code on your computer\", press Connect this computer, and run the command it shows.");
    process.exit(2);
  }
  const checked = checkedLink(JSON.parse(readFileSync(configPath, "utf8")).link);
  if (!checked.ok) {
    say(`The saved link is not usable. ${checked.reason}`);
    process.exit(2);
  }
  return checked.link;
}

const link = loadLink();
if (install) manageService();

// --sandbox: the sandbox program must be there before the runner takes any job. Missing is a refusal, never a quiet run without it.
const sandboxHas = sandbox ? { bwrap: process.platform === "linux" && Boolean(onPath("bwrap")), sandboxExec: process.platform === "darwin" && Boolean(onPath("sandbox-exec")) } : {};
if (sandbox) {
  const plan = sandboxPlan({ requested: true, platform: process.platform, has: sandboxHas, command: [claudeBin], repoDir: root, home: homedir(), workDir: tmpdir() });
  if (!plan.ok) {
    say(plan.reason);
    process.exit(2);
  }
  say(`Claude Code runs inside ${plan.sandbox}: it can write only in this folder, the temporary folder and its own settings. The network is not limited.`);
}
let rpcId = 0;

/** One call to a Meridian connector tool. Throws on a network failure; returns the tool's data and whether it reported an error. */
async function tool(name, args) {
  const response = await fetch(link, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error("Meridian did not accept the link. It may have been revoked: make a new one in Meridian: open Create and choose \"Free, with Claude Code on your computer\".");
  if (!response.ok) throw new Error(`Meridian answered ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Meridian refused the call.");
  return { data: body.result?.structuredContent ?? {}, text: body.result?.content?.[0]?.text ?? "", isError: body.result?.isError === true };
}

/** What this computer is missing, in plain words. Empty when it can make a video. */
function preflight() {
  const problems = [];
  if (Number(process.versions.node.split(".")[0]) < 22) problems.push(`Node.js 22 or newer is needed. This is ${process.versions.node}. Get it from nodejs.org.`);
  const version = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0 || !versionOf(version.stdout)) {
    problems.push("Claude Code is not installed on this computer, or is not on the PATH. Install it from claude.com/claude-code.");
  } else {
    const auth = spawnSync(claudeBin, ["auth", "status"], { encoding: "utf8", env: childEnv(process.env) });
    if (auth.status !== 0) problems.push("Claude Code is not signed in. Run `claude` once and sign in.");
  }
  for (const program of ["ffmpeg", "ffprobe"]) {
    const found = spawnSync(program, ["-version"], { encoding: "utf8" });
    if (found.error || found.status !== 0) problems.push(`${program} is not installed. It is needed to make the video file.`);
  }
  return problems;
}

async function runJob(job) {
  const work = mkdtempSync(join(tmpdir(), "meridian-runner-"));
  const mcpPath = join(work, "mcp.json");
  writeFileSync(mcpPath, mcpConfig(link), { mode: 0o600 });
  const logDir = join(home, "runner-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${job.requestId}-${job.attempt}.log`);
  // Only the newest logs are kept, so this folder does not grow without end.
  try {
    const files = readdirSync(logDir).map((name) => ({ name, mtimeMs: statSync(join(logDir, name)).mtimeMs }));
    for (const name of logsToDelete(files)) rmSync(join(logDir, name), { force: true });
  } catch {
    // A log that cannot be removed is left; it does not stop the job.
  }
  say(`Making ${job.requestId} (attempt ${job.attempt}, model ${job.model}). Log: ${logPath}`);

  const command = [claudeBin, ...claudeArgs({ prompt: job.prompt, model: job.model, sessionId: job.sessionId, mcpConfigPath: mcpPath, keepSession })];
  const claudeDirs = [join(homedir(), ".claude"), join(homedir(), ".claude.json")].filter((path) => existsSync(path));
  const plan = sandboxPlan({ requested: sandbox, platform: process.platform, has: sandboxHas, command, repoDir: root, home: homedir(), workDir: work, tmpDirs: [tmpdir()], claudeDirs });
  if (!plan.ok) {
    // Checked at start; a sandbox that vanished since is still a refusal.
    rmSync(work, { recursive: true, force: true });
    await tool("meridian_runner_report", { requestId: job.requestId, leaseToken: job.leaseToken, state: "failed", error: plan.reason }).catch(() => undefined);
    say(plan.reason);
    return;
  }
  // Its own process group, so stopping a job stops everything it started (node, ffmpeg), not only Claude Code.
  const child = spawn(plan.bin, plan.args, {
    cwd: root,
    env: childEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnGroupOptions(process.platform),
  });
  let rest = "";
  let resultLine = null;
  let stderr = "";
  let tail = "";
  let label = "Starting Claude Code";
  let sentLabel = "";
  let lastSent = 0;
  let timedOut = false;
  let lost = false;
  let ended = false;
  // Only a job that is still running is stopped: a late answer after the end must not signal a process group that is gone.
  const stopTree = () => { if (!ended) stopProcessTree(child); };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const beat = () => {
    lastSent = Date.now();
    sentLabel = label;
    tool("meridian_runner_report", { requestId: job.requestId, leaseToken: job.leaseToken, state: "heartbeat", progress: label })
      .then((answer) => {
        // Meridian says this job is no longer ours (cancelled, or taken back): stop working on it.
        if (answer.isError && !ended) { lost = true; stopTree(); }
      })
      .catch(() => undefined); // A missed heartbeat is retried at the next one; the lease lasts several.
  };
  child.stdout.on("data", (chunk) => {
    appendFileSync(logPath, redact(chunk, link));
    const split = splitLines(rest, chunk);
    rest = split.rest.length > 1_000_000 ? "" : split.rest;
    for (const line of split.lines) {
      if (isResultLine(line)) resultLine = line;
      else tail = line.slice(-2000);
      const next = progressLabel(line);
      if (next && next !== "Finishing") label = next;
    }
    if (label !== sentLabel && Date.now() - lastSent >= PROGRESS_MIN_MS) beat();
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); appendFileSync(logPath, redact(chunk, link)); });

  const timeout = setTimeout(() => { timedOut = true; stopTree(); }, JOB_TIMEOUT_MS);
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  current = child;

  const end = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 127, signal: null, spawnError: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  ended = true;
  clearTimeout(timeout);
  clearInterval(heartbeat);
  current = null;
  rmSync(work, { recursive: true, force: true });

  if (lost) { say(`${job.requestId} was cancelled or taken back in Meridian. Stopped.`); return; }
  if (stopping) { say(`${job.requestId} was interrupted. Meridian will queue it again.`); return; }
  const result = end.spawnError
    ? { ok: false, reason: `Claude Code could not be started: ${end.spawnError}` }
    : readEnd({ code: end.code, signal: end.signal, stdout: resultLine ?? (isResultLine(rest) ? rest : tail), stderr, timedOut });
  // The last step, and how many turns and how long it took when Claude Code said so. Unknown stays out, never 0.
  const measured = { progress: label, ...(result.turns === null || result.turns === undefined ? {} : { turns: result.turns }), ...(result.durationMs === null || result.durationMs === undefined ? {} : { durationMs: result.durationMs }) };
  const report = result.ok
    ? { requestId: job.requestId, leaseToken: job.leaseToken, state: "done", ...measured }
    : { requestId: job.requestId, leaseToken: job.leaseToken, state: "failed", error: redact(result.reason, link), ...measured };
  try {
    const answer = await tool("meridian_runner_report", report);
    say(`${job.requestId}: ${answer.text}`);
  } catch (error) {
    say(`${job.requestId} ended, but Meridian could not be told (${error.message}). It will be queued again when its lease runs out.`);
  }
}

/**
 * Stops a job's whole process tree: SIGTERM to its process group (taskkill /T on Windows), then SIGKILL ten seconds later if anything is
 * still running.
 */
function stopProcessTree(child) {
  const send = (force) => {
    const how = treeKill(process.platform, child.pid, force);
    if (!how) return;
    try {
      if (how.command) spawnSync(how.command[0], how.command.slice(1), { stdio: "ignore" });
      else process.kill(how.pid, how.signal);
    } catch {
      // The group has already gone.
    }
  };
  send(false);
  setTimeout(() => send(true), 10_000).unref();
}

let current = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    say("Stopping.");
    if (current) stopProcessTree(current);
    else process.exit(0);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastProblems = "";
let announced = false;
let failures = 0;
let checkedAt = 0;
let problems = [];
while (!stopping) {
  // The checks start other programs, so they are repeated once a minute, not on every poll.
  if (Date.now() - checkedAt > 60_000) { problems = preflight(); checkedAt = Date.now(); }
  const key = problems.join("|");
  if (key !== lastProblems) {
    for (const problem of problems) say(`Cannot make videos yet: ${problem}`);
    if (problems.length === 0 && lastProblems) say("Ready again.");
    lastProblems = key;
  }
  try {
    const next = await tool("meridian_runner_next", { runner: runnerName, problems, take: true });
    failures = 0;
    if (!announced) { say(`Connected as "${runnerName}". Waiting for videos you ask for in Meridian.`); announced = true; }
    if (next.data.job) await runJob(next.data.job);
  } catch (error) {
    failures += 1;
    if (failures === 1 || failures % 12 === 0) say(`Cannot reach Meridian: ${error.message} Trying again.`);
    if (/did not accept the link/.test(error.message)) process.exit(2);
  }
  if (once) break;
  // Back off while Meridian is unreachable, up to a minute, so a down server is not hammered.
  await sleep(Math.min(POLL_MS * Math.max(1, failures), 60_000));
}
process.exit(0);
