#!/usr/bin/env node
/**
 * The Claude Code runner. Run it on your own computer, in the Meridian folder:
 *
 *   npm run claude:runner -- <the link Meridian shows>     (the first time: the link is saved for next time)
 *   npm run claude:runner                                   (after that)
 *
 * It waits for videos you ask for in Meridian (Settings, Connections, "Make a video with Claude Code"). For each one it starts a fresh
 * Claude Code session with the model you chose, lets it make and upload the video, and tells Meridian how it ended. It uses your own
 * Claude Code sign-in and calls no paid provider. Stop it with Ctrl+C: a job it was making is queued again.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedLink, childEnv, claudeArgs, HEARTBEAT_MS, JOB_TIMEOUT_MS, mcpConfig, POLL_MS, readEnd, redact, versionOf } from "./claude-code-runner-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.MERIDIAN_RUNNER_HOME || join(root, ".meridian");
const configPath = join(home, "runner.json");
const claudeBin = process.env.CLAUDE_BIN || "claude";
const once = process.argv.includes("--once");
const runnerName = (process.env.MERIDIAN_RUNNER_NAME || hostname() || "runner").slice(0, 120);

const say = (line) => console.log(`[runner] ${line}`);

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
    say("No link is saved yet. In Meridian open Settings, Connections, Make a video with Claude Code, press Connect Claude Code, and run the command it shows.");
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
let rpcId = 0;

/** One call to a Meridian connector tool. Throws on a network failure; returns the tool's data and whether it reported an error. */
async function tool(name, args) {
  const response = await fetch(link, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error("Meridian did not accept the link. It may have been revoked: make a new one in Settings.");
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
  say(`Making ${job.requestId} (attempt ${job.attempt}, model ${job.model}). Log: ${logPath}`);

  const child = spawn(claudeBin, claudeArgs({ prompt: job.prompt, model: job.model, sessionId: job.sessionId, mcpConfigPath: mcpPath }), {
    cwd: root,
    env: childEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let lost = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; appendFileSync(logPath, redact(chunk, link)); });
  child.stderr.on("data", (chunk) => { stderr += chunk; appendFileSync(logPath, redact(chunk, link)); });

  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, JOB_TIMEOUT_MS);
  const heartbeat = setInterval(() => {
    tool("meridian_runner_report", { requestId: job.requestId, leaseToken: job.leaseToken, state: "heartbeat" })
      .then((answer) => {
        // Meridian says this job is no longer ours (cancelled, or taken back): stop working on it.
        if (answer.isError) { lost = true; child.kill("SIGTERM"); }
      })
      .catch(() => undefined); // A missed heartbeat is retried at the next one; the lease lasts several.
  }, HEARTBEAT_MS);
  current = child;

  const end = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 127, signal: null, spawnError: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  clearInterval(heartbeat);
  current = null;
  rmSync(work, { recursive: true, force: true });

  if (lost) { say(`${job.requestId} was cancelled or taken back in Meridian. Stopped.`); return; }
  if (stopping) { say(`${job.requestId} was interrupted. Meridian will queue it again.`); return; }
  const result = end.spawnError
    ? { ok: false, reason: `Claude Code could not be started: ${end.spawnError}` }
    : readEnd({ code: end.code, signal: end.signal, stdout, stderr, timedOut });
  const report = result.ok
    ? { requestId: job.requestId, leaseToken: job.leaseToken, state: "done" }
    : { requestId: job.requestId, leaseToken: job.leaseToken, state: "failed", error: redact(result.reason, link) };
  try {
    const answer = await tool("meridian_runner_report", report);
    say(`${job.requestId}: ${answer.text}`);
  } catch (error) {
    say(`${job.requestId} ended, but Meridian could not be told (${error.message}). It will be queued again when its lease runs out.`);
  }
}

let current = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    say("Stopping.");
    if (current) current.kill("SIGTERM");
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
