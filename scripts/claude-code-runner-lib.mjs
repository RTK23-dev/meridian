// The pure parts of the Claude Code runner: how Claude Code is started, what it may use, and how its end is read. No process, file or
// network work happens here, so each rule is tested directly (claude-code-runner.test.mjs).

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
    "--output-format", "json",
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

/**
 * Reads how a Claude Code run ended. Success needs exit code 0 and, when the output is the JSON result, no error flag. Anything else is
 * a failure with the most useful reason found. An unknown is a failure: it is never assumed to have worked.
 */
export function readEnd({ code, signal, stdout, stderr, timedOut }) {
  if (timedOut) return { ok: false, reason: `It ran longer than ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes and was stopped.` };
  let parsed = null;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    parsed = null;
  }
  const result = parsed && typeof parsed === "object" ? parsed : null;
  const text = result && typeof result.result === "string" ? result.result : "";
  if (code === 0 && !(result && result.is_error === true)) return { ok: true, summary: text.slice(-600) };
  const why = text || String(stderr ?? "").trim() || String(stdout ?? "").trim();
  const how = signal ? `was stopped (${signal})` : `ended with code ${code}`;
  return { ok: false, reason: `Claude Code ${how}. ${why.slice(-500)}`.trim() };
}

/** The first version number in `claude --version`, or null. */
export function versionOf(text) {
  return /\d+\.\d+\.\d+/.exec(String(text ?? ""))?.[0] ?? null;
}

/** The log files to delete, oldest first, so that only the newest LOGS_KEPT stay. `files` is [{ name, mtimeMs }]. */
export function logsToDelete(files, keep = LOGS_KEPT) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(keep).map((file) => file.name);
}
