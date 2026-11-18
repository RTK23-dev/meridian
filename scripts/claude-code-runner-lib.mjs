// The pure parts of the Claude Code runner: how Claude Code is started, what it may use, how its progress and its end are read, the
// service file that starts it with the computer, and the sandbox it can run in. No process, file or network work happens here, so each
// rule is tested directly (claude-code-runner.test.mjs).

import { posix, win32 } from "node:path";

/** How long one job may run before the runner stops it. */
export const JOB_TIMEOUT_MS = 45 * 60 * 1000;
export const POLL_MS = 5_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_TURNS = 250;

/**
 * What the unattended session may use without asking: Meridian's own tools, the file tools, skills, and the four programs a local
 * render and upload need. Everything else is refused, because nobody is there to approve it. Claude Code's Bash rules match the command
 * text and are not a sandbox, so this narrows what the session does; it is not a security boundary.
 */
export const ALLOWED_TOOLS = [
  "mcp__meridian__*",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Skill",
  "Bash(node *)",
  "Bash(ffmpeg *)",
  "Bash(ffprobe *)",
  "Bash(curl *)",
];

/** The connector link, checked. It is a secret: it is never printed, logged or put on a command line. */
export function checkedLink(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return { ok: false, reason: "That is not a web address. Copy the whole link Meridian showed." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    return { ok: false, reason: "The link must start with https:// (http:// is accepted only for a Meridian on this computer)." };
  }
  if (!/^\/api\/mcp\/[^/]{16,}$/.test(url.pathname)) return { ok: false, reason: "That is not a Meridian connector link. It ends in /api/mcp/ followed by a long code." };
  return { ok: true, link: url.toString() };
}

/** The file Claude Code reads its one MCP server from. Passing a file keeps the link off the command line, where other programs could see it. */
export function mcpConfig(link) {
  return JSON.stringify({ mcpServers: { meridian: { type: "http", url: link } } });
}

/** How many job logs the runner keeps. Older ones are deleted, so the folder does not grow without end. */
export const LOGS_KEPT = 50;

/**
 * The arguments Claude Code is started with for one job: print mode, the chosen model, a conversation of its own, only Meridian's MCP
 * server, and the allowed tools. Anything not allowed is denied, not asked.
 *
 * Every job starts from nothing, but its conversation is NOT saved: a saved one per video would fill the person's Claude Code history
 * with chats they never opened. The runner's own log of the job is the record. `keepSession` saves it under the job's session id, for
 * looking into one job with `claude --resume`.
 */
export function claudeArgs({ prompt, model, sessionId, mcpConfigPath, keepSession = false }) {
  return [
    "-p", prompt,
    "--model", model,
    ...(keepSession ? ["--session-id", sessionId] : ["--no-session-persistence"]),
    // One JSON event per line while it works, so the runner can show what it is doing; the last line is the result. `--verbose` is
    // required by Claude Code for stream-json in print mode.
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--max-turns", String(MAX_TURNS),
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools", ...ALLOWED_TOOLS,
  ];
}

/** The environment Claude Code runs in: the person's own sign-in is used, so an API key in the environment is left out and nothing is billed to one. */
export function childEnv(env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

/** Removes the connector link (and its code) from text before it is logged or reported. */
export function redact(text, link) {
  let out = String(text ?? "");
  if (link) {
    out = out.split(link).join("[connector link]");
    const code = link.split("/").pop();
    if (code && code.length >= 16) out = out.split(code).join("[connector code]");
  }
  return out;
}

/** A label is at most this long. Meridian stores at most the same. */
export const PROGRESS_MAX = 120;

/** What each Meridian tool means, in words a person reads under "Being made". Unknown Meridian tools read "Working in Meridian". */
const MERIDIAN_STEPS = {
  meridian_request: "Reading the request",
  meridian_start: "Planning",
  meridian_project_create: "Planning",
  meridian_project: "Planning",
  meridian_skills: "Getting the video skills",
  meridian_upload_link: "Saving the video",
  meridian_upload: "Saving the video",
};

/** What a shell command is doing, from its program only. The command text itself never reaches the label. */
function bashStep(command) {
  const text = typeof command === "string" ? command.trim() : "";
  const program = text.split(/\s+/)[0] ?? "";
  if (program === "node") return /render/i.test(text) ? "Rendering" : "Running a script";
  if (program === "ffmpeg" || program === "ffprobe") return "Checking the video";
  if (program === "curl") return "Saving the video";
  return "Running a command";
}

/** One tool call as a label. Arguments are never copied in, except a skill's name when it is a plain skill name. */
function toolStep(name, input) {
  const tool = typeof name === "string" ? name : "";
  if (tool.startsWith("mcp__meridian__")) return MERIDIAN_STEPS[tool.slice("mcp__meridian__".length)] ?? "Working in Meridian";
  if (tool.startsWith("mcp__")) return "Using a tool";
  if (tool === "Bash") return bashStep(input?.command);
  if (tool === "Skill") {
    const skill = typeof input?.skill === "string" ? input.skill : typeof input?.command === "string" ? input.command : "";
    return /^[a-z0-9][a-z0-9:_-]{0,59}$/i.test(skill) ? `Following the ${skill} skill` : "Following a skill";
  }
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") return "Writing files";
  if (tool === "Read" || tool === "Glob" || tool === "Grep") return "Reading files";
  if (tool === "TodoWrite") return "Planning";
  return tool ? "Working" : null;
}

/**
 * One line of Claude Code's stream-json output, as a short plain label of what it is doing, or null when the line says nothing new
 * (text, a tool's answer, an unreadable line). The label names the step, never the link, a command or a tool's arguments. The output is
 * the model's and is data: it is only matched against fixed words here.
 */
export function progressLabel(line) {
  let event;
  try {
    event = JSON.parse(String(line ?? "").trim());
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  if (event.type === "system" && event.subtype === "init") return "Starting Claude Code";
  if (event.type === "result") return "Finishing";
  if (event.type !== "assistant") return null;
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const calls = content.filter((part) => part && part.type === "tool_use");
  const last = calls[calls.length - 1];
  if (!last) return null;
  const label = toolStep(last.name, last.input);
  return label ? label.slice(0, PROGRESS_MAX) : null;
}

/** Splits streamed text into whole lines. Returns the complete lines and the unfinished rest, to carry into the next chunk. */
export function splitLines(rest, chunk) {
  const parts = (String(rest ?? "") + String(chunk ?? "")).split("\n");
  return { lines: parts.slice(0, -1).filter((line) => line.trim() !== ""), rest: parts[parts.length - 1] ?? "" };
}

/** True when a line is Claude Code's final result event (stream-json's last line, or the whole output of --output-format json). */
export function isResultLine(line) {
  try {
    const event = JSON.parse(String(line ?? "").trim());
    return Boolean(event && typeof event === "object" && event.type === "result");
  } catch {
    return false;
  }
}

/**
 * The final result in Claude Code's output: the one JSON object of `--output-format json`, or the last `result` event of stream-json.
 * Null when there is none.
 */
export function finalResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === "object" && !Array.isArray(whole) && (whole.type === "result" || "result" in whole || "is_error" in whole)) return whole;
  } catch {
    // Not one object: read it as one event per line.
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isResultLine(lines[i])) return JSON.parse(lines[i].trim());
  }
  return null;
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * Reads how a Claude Code run ended. Success needs exit code 0 AND a final result that carries no error flag. A run with no final
 * result is a failure: it is never assumed to have worked. The number of turns and how long it took are kept when Claude Code gave them,
 * and are null when it did not.
 */
export function readEnd({ code, signal, stdout, stderr, timedOut }) {
  const result = finalResult(stdout);
  const turns = count(result?.num_turns);
  const durationMs = count(result?.duration_ms);
  if (timedOut) return { ok: false, reason: `It ran longer than ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes and was stopped.`, turns, durationMs };
  const text = result && typeof result.result === "string" ? result.result : "";
  if (code === 0 && result && result.is_error !== true) return { ok: true, summary: text.slice(-600), turns, durationMs };
  if (code === 0 && !result) {
    const why = String(stderr ?? "").trim();
    return { ok: false, reason: `Claude Code ended without a final result, so it is not known to have finished. ${why.slice(-400)}`.trim(), turns, durationMs };
  }
  const subtype = result && typeof result.subtype === "string" && result.subtype !== "success" ? ` (${result.subtype.slice(0, 40)})` : "";
  const why = text || String(stderr ?? "").trim();
  const how = code === 0 ? `reported an error${subtype}` : signal ? `was stopped (${signal})` : `ended with code ${code}${subtype}`;
  return { ok: false, reason: `Claude Code ${how}. ${why.slice(-500)}`.trim(), turns, durationMs };
}

/** The first version number in `claude --version`, or null. */
export function versionOf(text) {
  return /\d+\.\d+\.\d+/.exec(String(text ?? ""))?.[0] ?? null;
}

/** The log files to delete, oldest first, so that only the newest LOGS_KEPT stay. `files` is [{ name, mtimeMs }]. */
export function logsToDelete(files, keep = LOGS_KEPT) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(keep).map((file) => file.name);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Start on login: one per-user service file per system. Each is built here from paths the script passes in, so tests never touch a real
// home folder. The service runs the runner from the repository folder; the link stays in .meridian/runner.json and never enters the file.
// ---------------------------------------------------------------------------------------------------------------------------------

export const SERVICE_LABEL = "com.meridian.claude-runner";
export const SERVICE_UNIT = "meridian-claude-runner.service";
export const SERVICE_CMD = "meridian-claude-runner.cmd";
/** The runner's own flags a service may carry. Anything else (above all, a link) is refused. */
export const SERVICE_FLAGS = ["--sandbox", "--keep-sessions"];

const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A systemd word: quoted, with backslash, quote and % escaped (systemd expands %). */
const unitWord = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
/** A cmd.exe word in double quotes. A double quote cannot appear in a Windows path. */
const cmdWord = (value) => `"${String(value).replace(/%/g, "%%")}"`;

/**
 * Checks what goes into a service file. The node path must be absolute (a service has no shell to find `node`), the repository and script
 * must be absolute, and only the runner's own flags are allowed. Throws with a plain reason otherwise.
 */
function checkedService({ platform, nodePath, repoDir, scriptPath, flags = [] }) {
  const path = platform === "win32" ? win32 : posix;
  for (const [what, value] of [["The Node.js path", nodePath], ["The Meridian folder", repoDir], ["The runner script", scriptPath]]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${what} must be a full path, not ${JSON.stringify(value)}.`);
    if (/[\r\n]/.test(value)) throw new Error(`${what} cannot contain a line break.`);
  }
  for (const flag of flags) if (!SERVICE_FLAGS.includes(flag)) throw new Error(`The service can carry only ${SERVICE_FLAGS.join(" and ")}, not ${flag}.`);
  if (/\/api\/mcp\//.test([nodePath, repoDir, scriptPath, ...flags].join(" "))) throw new Error("A connector link never goes into a service file.");
  return path;
}

/**
 * The service file for this computer, and the commands that turn it on and off. `platform` is process.platform; `home` is the person's
 * home folder; `searchPath` is the PATH the service runs with (so it finds `claude`, `ffmpeg` and `ffprobe`, as the terminal does).
 * Restarts: systemd and the Windows loop restart the runner when it stops, except on exit code 2 (the link is missing or refused, which a
 * restart cannot fix); launchd restarts it at most once a minute.
 */
export function serviceFile({ platform, home, nodePath, repoDir, scriptPath, searchPath = "", flags = [] }) {
  const path = checkedService({ platform, nodePath, repoDir, scriptPath, flags });
  if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("The home folder must be a full path.");
  const logPath = path.join(repoDir, ".meridian", "runner-service.log");
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const args = [nodePath, scriptPath, ...flags].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      args,
      "  </array>",
      `  <key>WorkingDirectory</key><string>${xml(repoDir)}</string>`,
      "  <key>EnvironmentVariables</key>",
      `  <dict><key>PATH</key><string>${xml(searchPath)}</string></dict>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "  <key>ThrottleInterval</key><integer>60</integer>",
      `  <key>StandardOutPath</key><string>${xml(logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return { platform, file, content, enable: [["launchctl", "load", "-w", file]], disable: [["launchctl", "unload", "-w", file]] };
  }
  if (platform === "linux") {
    const file = path.join(home, ".config", "systemd", "user", SERVICE_UNIT);
    const content = [
      "[Unit]",
      "Description=Meridian Claude Code runner (makes the videos asked for in Meridian)",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      // WorkingDirectory takes the path as it is (no quotes); only % is special.
      `WorkingDirectory=${String(repoDir).replace(/%/g, "%%")}`,
      `Environment=${unitWord(`PATH=${searchPath}`)}`,
      `ExecStart=${[nodePath, scriptPath, ...flags].map(unitWord).join(" ")}`,
      "Restart=always",
      "RestartSec=10",
      "RestartPreventExitStatus=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      platform,
      file,
      content,
      enable: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", SERVICE_UNIT]],
      disable: [["systemctl", "--user", "disable", "--now", SERVICE_UNIT]],
    };
  }
  if (platform === "win32") {
    const file = path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", SERVICE_CMD);
    const content = [
      "@echo off",
      "rem Meridian Claude Code runner: starts when you sign in, and starts again if it stops.",
      `cd /d ${cmdWord(repoDir)}`,
      ":loop",
      `${[nodePath, scriptPath, ...flags].map(cmdWord).join(" ")} >> ${cmdWord(logPath)} 2>&1`,
      "if %errorlevel% equ 2 goto end",
      "timeout /t 10 /nobreak >nul",
      "goto loop",
      ":end",
      "",
    ].join("\r\n");
    return { platform, file, content, enable: [["cmd", "/c", "start", '""', "/min", file]], disable: [] };
  }
  throw new Error(`Starting with the computer is not set up for ${platform}. Run npm run claude:runner in a terminal instead.`);
}

/** A command as one line to show a person, each word quoted when it needs to be. */
export function shownCommand(words) {
  return words.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) || word === '""' ? word : `"${String(word).replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Containment (--sandbox). Claude Code's Bash rules match command text and are not a sandbox. With --sandbox the runner starts Claude Code
// inside the system's own sandbox: bubblewrap on Linux, sandbox-exec on macOS. It limits which files can be written, not the network:
// Claude Code must reach Anthropic and Meridian.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * bubblewrap arguments: the whole system read-only, a private /tmp, the repository writable, Claude Code's own settings folder writable
 * (it keeps its sign-in there), the job's folder (it holds the MCP config) read-only, and the network shared. The sandbox ends with the
 * runner.
 */
export function bwrapArgs({ repoDir, home, workDir, claudeDirs = [], command }) {
  for (const value of [repoDir, home, workDir, ...claudeDirs]) if (!posix.isAbsolute(String(value))) throw new Error(`The sandbox needs full paths, not ${JSON.stringify(value)}.`);
  return [
    "--die-with-parent",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", repoDir, repoDir,
    ...claudeDirs.flatMap((dir) => ["--bind", dir, dir]),
    "--ro-bind", workDir, workDir,
    "--chdir", repoDir,
    "--setenv", "TMPDIR", "/tmp",
    "--",
    ...command,
  ];
}

const sbString = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sbRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\/"]/g, "\\$&");

/**
 * A sandbox-exec profile: everything is allowed except writing files, and writing is allowed only in the repository, the temporary
 * folders, Claude Code's own settings (~/.claude, ~/.claude.json) and the terminal devices. Reads and the network are not limited.
 */
export function sandboxExecProfile({ repoDir, home, tmpDirs = [] }) {
  for (const value of [repoDir, home, ...tmpDirs]) if (!posix.isAbsolute(String(value))) throw new Error(`The sandbox needs full paths, not ${JSON.stringify(value)}.`);
  const writable = [repoDir, "/private/tmp", "/private/var/folders", ...tmpDirs].map((dir) => `  (subpath ${sbString(dir)})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...writable,
    `  (regex #"^${sbRegex(home)}/\\.claude")`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    "",
  ].join("\n");
}

/**
 * How Claude Code is started: directly, or inside a sandbox when one is asked for. Asked for and not available is a refusal, never a
 * quiet run without it. `has` says which sandbox programs were found on this computer.
 */
export function sandboxPlan({ requested, platform, has = {}, command, repoDir, home, workDir, tmpDirs = [], claudeDirs = [] }) {
  if (!requested) return { ok: true, sandbox: null, bin: command[0], args: command.slice(1) };
  if (platform === "linux") {
    if (!has.bwrap) return { ok: false, reason: "--sandbox was asked for, but bubblewrap (bwrap) is not installed. Install it (for example `sudo apt install bubblewrap`) or start without --sandbox. The runner did not start." };
    return { ok: true, sandbox: "bubblewrap", bin: "bwrap", args: bwrapArgs({ repoDir, home, workDir, claudeDirs, command }) };
  }
  if (platform === "darwin") {
    if (!has.sandboxExec) return { ok: false, reason: "--sandbox was asked for, but sandbox-exec is not on this Mac. Start without --sandbox. The runner did not start." };
    return { ok: true, sandbox: "sandbox-exec", bin: "sandbox-exec", args: ["-p", sandboxExecProfile({ repoDir, home, tmpDirs: [...tmpDirs, workDir] }), ...command] };
  }
  return { ok: false, reason: `--sandbox is not available on ${platform}. Start without --sandbox. The runner did not start.` };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Stopping a job: the whole process tree, not only Claude Code itself (it starts node, ffmpeg and others).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Spawn options so that a job can be stopped as a whole: its own process group off Windows. */
export function spawnGroupOptions(platform) {
  return { detached: platform !== "win32" };
}

/** How to stop a job's process tree: the negative pid (its group) off Windows, `taskkill /T` on Windows. */
export function treeKill(platform, pid, force = false) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") return { command: ["taskkill", "/pid", String(pid), "/T", ...(force ? ["/F"] : [])] };
  return { pid: -pid, signal: force ? "SIGKILL" : "SIGTERM" };
}
