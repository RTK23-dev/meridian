import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  logsToDelete, LOGS_KEPT, ALLOWED_TOOLS, checkedLink, childEnv, claudeArgs, mcpConfig, readEnd, redact, versionOf, progressLabel, splitLines, finalResult,
  isResultLine, serviceFile, shownCommand, bwrapArgs, sandboxExecProfile, sandboxPlan, spawnGroupOptions, treeKill, PROGRESS_MAX, SERVICE_UNIT,
} from "./claude-code-runner-lib.mjs";

const LINK = "https://meridian.example/api/mcp/mrd_ABCDEFGHIJKLMNOPQRSTUV";

describe("the Claude Code runner's rules", () => {
  test("accepts a Meridian connector link and refuses anything else", () => {
    assert.equal(checkedLink(LINK).ok, true);
    assert.equal(checkedLink("http://127.0.0.1:8080/api/mcp/mrd_ABCDEFGHIJKLMNOPQRSTUV").ok, true);
    assert.equal(checkedLink("http://meridian.example/api/mcp/mrd_ABCDEFGHIJKLMNOPQRSTUV").ok, false, "plain http is only for this computer");
    assert.equal(checkedLink("https://meridian.example/settings").ok, false);
    assert.equal(checkedLink("not a link").ok, false);
    assert.equal(checkedLink("").ok, false);
  });

  test("starts Claude Code with the chosen model, a session of its own, only Meridian's server, and nothing it must ask for", () => {
    const args = claudeArgs({ prompt: "do it", model: "sonnet", sessionId: "11111111-1111-4111-8111-111111111111", mcpConfigPath: "/tmp/x/mcp.json" });
    assert.deepEqual(args.slice(0, 2), ["-p", "do it"]);
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
    assert.ok(args.includes("--no-session-persistence"), "a job's conversation is not saved, so the person's Claude Code history does not fill up");
    assert.ok(!args.includes("--session-id"));
    const kept = claudeArgs({ prompt: "do it", model: "sonnet", sessionId: "11111111-1111-4111-8111-111111111111", mcpConfigPath: "/tmp/x/mcp.json", keepSession: true });
    assert.equal(kept[kept.indexOf("--session-id") + 1], "11111111-1111-4111-8111-111111111111");
    assert.ok(!kept.includes("--no-session-persistence"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(args.includes("--verbose"), "stream-json in print mode needs --verbose");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/x/mcp.json");
    assert.ok(!args.join(" ").includes("bypassPermissions"));
    assert.ok(!args.join(" ").includes("/api/mcp/"), "the link is never on the command line");
  });

  test("allows Meridian's tools, file tools and four programs, and no open shell", () => {
    assert.ok(ALLOWED_TOOLS.includes("mcp__meridian__*"));
    assert.ok(!ALLOWED_TOOLS.includes("Bash"), "Bash is never allowed without a command");
    assert.deepEqual(ALLOWED_TOOLS.filter((tool) => tool.startsWith("Bash(")).sort(), ["Bash(curl *)", "Bash(ffmpeg *)", "Bash(ffprobe *)", "Bash(node *)"]);
  });

  test("puts the link in a config file for one server named meridian", () => {
    assert.deepEqual(JSON.parse(mcpConfig(LINK)), { mcpServers: { meridian: { type: "http", url: LINK } } });
  });

  test("leaves an API key out of Claude Code's environment, so the person's own sign-in is used", () => {
    const env = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" });
    assert.deepEqual(env, { PATH: "/bin" });
  });

  test("removes the link and its code from anything logged or reported", () => {
    const text = redact(`calling ${LINK} and mrd_ABCDEFGHIJKLMNOPQRSTUV again`, LINK);
    assert.ok(!text.includes("mrd_ABCDEFGHIJKLMNOPQRSTUV"));
    assert.match(text, /\[connector link\]/);
  });

  test("reads the end of a run: only a clean exit with no error flag is success", () => {
    assert.deepEqual(readEnd({ code: 0, signal: null, stdout: JSON.stringify({ result: "Saved file f1", is_error: false }), stderr: "", timedOut: false }), { ok: true, summary: "Saved file f1", turns: null, durationMs: null });
    assert.equal(readEnd({ code: 0, signal: null, stdout: JSON.stringify({ result: "ran out of turns", is_error: true }), stderr: "", timedOut: false }).ok, false);
    assert.match(readEnd({ code: 1, signal: null, stdout: "", stderr: "not signed in", timedOut: false }).reason, /code 1\. not signed in/);
    assert.match(readEnd({ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true }).reason, /45 minutes/);
    assert.equal(readEnd({ code: 0, signal: null, stdout: "plain text, not JSON", stderr: "", timedOut: false }).ok, false, "no final result is a failure");
    assert.match(readEnd({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false }).reason, /without a final result/);
    assert.equal(readEnd({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false }).ok, false);
  });

  test("keeps only the newest job logs", () => {
    const files = Array.from({ length: LOGS_KEPT + 3 }, (_, i) => ({ name: `job-${i}.log`, mtimeMs: i }));
    assert.deepEqual(logsToDelete(files), ["job-2.log", "job-1.log", "job-0.log"]);
    assert.deepEqual(logsToDelete(files.slice(0, 5)), []);
  });

  test("finds the version number", () => {
    assert.equal(versionOf("2.1.310 (Claude Code)"), "2.1.310");
    assert.equal(versionOf("command not found"), null);
  });

  test("reads the final result from the json object and from the stream's last result event", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__meridian__meridian_request", input: { requestId: "ccr_1" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Saved file f1", num_turns: 12, duration_ms: 243000 }),
    ].join("\n");
    assert.deepEqual(readEnd({ code: 0, signal: null, stdout: stream, stderr: "", timedOut: false }), { ok: true, summary: "Saved file f1", turns: 12, durationMs: 243000 });
    const json = JSON.stringify({ type: "result", result: "ok", is_error: false, num_turns: 3 });
    assert.deepEqual(readEnd({ code: 0, signal: null, stdout: json, stderr: "", timedOut: false }), { ok: true, summary: "ok", turns: 3, durationMs: null });
    const noEnd = stream.split("\n").slice(0, 2).join("\n");
    assert.equal(readEnd({ code: 0, signal: null, stdout: noEnd, stderr: "", timedOut: false }).ok, false, "a stream that stops before its result is a failure");
    const maxed = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 250 });
    const failed = readEnd({ code: 0, signal: null, stdout: maxed, stderr: "", timedOut: false });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /error_max_turns/);
    assert.equal(failed.turns, 250);
    assert.equal(finalResult(""), null);
    assert.equal(isResultLine(JSON.stringify({ type: "result" })), true);
    assert.equal(isResultLine("{not json"), false);
  });

  test("turns stream events into short plain progress labels, without links, commands or arguments", () => {
    const call = (name, input = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "next" }, { type: "tool_use", id: "t", name, input }] } });
    assert.equal(progressLabel(JSON.stringify({ type: "system", subtype: "init" })), "Starting Claude Code");
    assert.equal(progressLabel(call("mcp__meridian__meridian_request", { requestId: "ccr_1" })), "Reading the request");
    assert.equal(progressLabel(call("mcp__meridian__meridian_project_create", { title: "x" })), "Planning");
    assert.equal(progressLabel(call("mcp__meridian__meridian_upload_link", { projectId: "p" })), "Saving the video");
    assert.equal(progressLabel(call("mcp__meridian__meridian_something_new")), "Working in Meridian");
    assert.equal(progressLabel(call("Bash", { command: "node scripts/render-local.mjs --out out.mp4" })), "Rendering");
    assert.equal(progressLabel(call("Bash", { command: "node -e 1" })), "Running a script");
    assert.equal(progressLabel(call("Bash", { command: "curl -X POST https://meridian.example/api/mcp/mrd_ABCDEFGHIJKLMNOPQRSTUV" })), "Saving the video");
    assert.equal(progressLabel(call("Bash", { command: "ffprobe out.mp4" })), "Checking the video");
    assert.equal(progressLabel(call("Skill", { skill: "meridian-video" })), "Following the meridian-video skill");
    assert.equal(progressLabel(call("Skill", { skill: "https://evil.example/ x" })), "Following a skill", "a skill name that is not a plain name is not shown");
    assert.equal(progressLabel(call("Write", { file_path: "/secret/path" })), "Writing files");
    assert.equal(progressLabel(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } })), null);
    assert.equal(progressLabel(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } })), null);
    assert.equal(progressLabel("not json"), null);
    assert.equal(progressLabel(""), null);
    for (const line of [call("Bash", { command: "curl https://meridian.example/api/mcp/mrd_ABCDEFGHIJKLMNOPQRSTUV" }), call("Skill", { skill: "x".repeat(500) })]) {
      const label = progressLabel(line);
      assert.ok(label.length <= PROGRESS_MAX);
      assert.doesNotMatch(label, /api\/mcp|mrd_|https?:/);
    }
  });

  test("splits streamed output into whole lines and carries the unfinished rest", () => {
    const first = splitLines("", '{"a":1}\n{"b"');
    assert.deepEqual(first, { lines: ['{"a":1}'], rest: '{"b"' });
    assert.deepEqual(splitLines(first.rest, ':2}\n\n'), { lines: ['{"b":2}'], rest: "" });
  });

  const SERVICE = { nodePath: "/usr/local/bin/node", repoDir: "/home/pat/meridian", scriptPath: "/home/pat/meridian/scripts/claude-code-runner.mjs", searchPath: "/usr/local/bin:/usr/bin" };

  test("writes a systemd user unit in ~/.config/systemd/user that runs the runner from the repository", () => {
    const unit = serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE });
    assert.equal(unit.file, `/home/pat/.config/systemd/user/${SERVICE_UNIT}`);
    assert.match(unit.content, /^ExecStart="\/usr\/local\/bin\/node" "\/home\/pat\/meridian\/scripts\/claude-code-runner.mjs"$/m);
    assert.match(unit.content, /^WorkingDirectory=\/home\/pat\/meridian$/m);
    assert.match(unit.content, /^Restart=always$/m);
    assert.match(unit.content, /^RestartPreventExitStatus=2$/m);
    assert.match(unit.content, /^WantedBy=default.target$/m);
    assert.deepEqual(unit.enable.at(-1), ["systemctl", "--user", "enable", "--now", SERVICE_UNIT]);
    assert.equal(shownCommand(unit.enable.at(-1)), `systemctl --user enable --now ${SERVICE_UNIT}`);
    assert.match(serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE, flags: ["--sandbox"] }).content, /claude-code-runner.mjs" "--sandbox"$/m);
    assert.match(serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE, repoDir: "/home/pat/my 100% folder" }).content, /^WorkingDirectory=\/home\/pat\/my 100%% folder$/m);
  });

  test("writes a LaunchAgent in ~/Library/LaunchAgents that starts at login and is kept alive", () => {
    const agent = serviceFile({ platform: "darwin", home: "/Users/pat", ...SERVICE, repoDir: "/Users/pat/a&b", scriptPath: "/Users/pat/a&b/scripts/claude-code-runner.mjs" });
    assert.equal(agent.file, "/Users/pat/Library/LaunchAgents/com.meridian.claude-runner.plist");
    assert.match(agent.content, /<string>\/usr\/local\/bin\/node<\/string>/);
    assert.match(agent.content, /<key>WorkingDirectory<\/key><string>\/Users\/pat\/a&amp;b<\/string>/);
    assert.match(agent.content, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(agent.content, /<key>KeepAlive<\/key><true\/>/);
    assert.deepEqual(agent.enable, [["launchctl", "load", "-w", agent.file]]);
  });

  test("writes a Windows Startup-folder script that restarts the runner when it stops", () => {
    const cmd = serviceFile({ platform: "win32", home: "C:\\Users\\pat", nodePath: "C:\\Program Files\\nodejs\\node.exe", repoDir: "C:\\code\\meridian", scriptPath: "C:\\code\\meridian\\scripts\\claude-code-runner.mjs" });
    assert.equal(cmd.file, "C:\\Users\\pat\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\meridian-claude-runner.cmd");
    assert.match(cmd.content, /cd \/d "C:\\code\\meridian"/);
    assert.match(cmd.content, /"C:\\Program Files\\nodejs\\node.exe" "C:\\code\\meridian\\scripts\\claude-code-runner.mjs"/);
    assert.match(cmd.content, /goto loop/);
    assert.match(cmd.content, /\r\n/);
  });

  test("refuses a service file with a relative node path, a link or an unknown flag, and puts no link or secret in any file", () => {
    assert.throws(() => serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE, nodePath: "node" }), /full path/);
    assert.throws(() => serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE, flags: [LINK] }), /can carry only/);
    assert.throws(() => serviceFile({ platform: "linux", home: "/home/pat", ...SERVICE, flags: ["--once"] }), /can carry only/);
    assert.throws(() => serviceFile({ platform: "aix", home: "/home/pat", ...SERVICE }), /not set up/);
    for (const platform of ["linux", "darwin"]) {
      const content = serviceFile({ platform, home: "/home/pat", ...SERVICE }).content;
      assert.doesNotMatch(content, /api\/mcp|mrd_|ANTHROPIC|TOKEN|KEY=/i);
    }
  });

  test("builds a bubblewrap sandbox: system read-only, private /tmp, repository writable, network shared", () => {
    const args = bwrapArgs({ repoDir: "/home/pat/meridian", home: "/home/pat", workDir: "/tmp/meridian-runner-x", claudeDirs: ["/home/pat/.claude"], command: ["claude", "-p", "go"] });
    const pairs = (flag) => args.flatMap((arg, i) => (arg === flag ? [args.slice(i + 1, i + 3).join(" ")] : []));
    assert.ok(pairs("--ro-bind").includes("/ /"), "the system is read-only");
    assert.ok(pairs("--bind").includes("/home/pat/meridian /home/pat/meridian"), "the repository is writable");
    assert.ok(pairs("--bind").includes("/home/pat/.claude /home/pat/.claude"), "Claude Code keeps its sign-in");
    assert.ok(pairs("--ro-bind").includes("/tmp/meridian-runner-x /tmp/meridian-runner-x"));
    assert.equal(args[args.indexOf("--tmpfs") + 1], "/tmp");
    assert.ok(args.indexOf("--tmpfs") < args.indexOf("/tmp/meridian-runner-x"), "the job folder is mounted on top of the private /tmp");
    assert.ok(!args.includes("--unshare-net") && !args.includes("--unshare-all"), "the network is needed");
    assert.ok(args.includes("--die-with-parent"));
    assert.deepEqual(args.slice(args.indexOf("--") + 1), ["claude", "-p", "go"]);
    assert.throws(() => bwrapArgs({ repoDir: "meridian", home: "/home/pat", workDir: "/tmp/x", command: ["claude"] }), /full paths/);
  });

  test("builds a sandbox-exec profile that denies writes outside the repository and the temporary folders", () => {
    const profile = sandboxExecProfile({ repoDir: "/Users/pat/meridian", home: "/Users/pat", tmpDirs: ["/var/folders/x/T"] });
    assert.match(profile, /^\(version 1\)/);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\(subpath "\/Users\/pat\/meridian"\)/);
    assert.match(profile, /\(subpath "\/private\/tmp"\)/);
    assert.match(profile, /\\\.claude/);
    assert.doesNotMatch(profile, /deny network/);
  });

  test("runs inside a sandbox only when asked, and refuses to start when the asked-for sandbox is missing", () => {
    const base = { command: ["claude", "-p", "go"], repoDir: "/r", home: "/h", workDir: "/tmp/w" };
    assert.deepEqual(sandboxPlan({ ...base, requested: false, platform: "linux" }), { ok: true, sandbox: null, bin: "claude", args: ["-p", "go"] });
    const linux = sandboxPlan({ ...base, requested: true, platform: "linux", has: { bwrap: true } });
    assert.equal(linux.bin, "bwrap");
    assert.match(sandboxPlan({ ...base, requested: true, platform: "linux", has: {} }).reason, /bubblewrap.*not installed.*did not start/);
    assert.equal(sandboxPlan({ ...base, requested: true, platform: "darwin", has: { sandboxExec: true } }).args[0], "-p");
    assert.equal(sandboxPlan({ ...base, requested: true, platform: "darwin", has: {} }).ok, false);
    assert.equal(sandboxPlan({ ...base, requested: true, platform: "win32", has: {} }).ok, false);
  });

  test("stops a job's whole process tree", () => {
    assert.deepEqual(spawnGroupOptions("linux"), { detached: true });
    assert.deepEqual(spawnGroupOptions("win32"), { detached: false });
    assert.deepEqual(treeKill("linux", 4321), { pid: -4321, signal: "SIGTERM" });
    assert.deepEqual(treeKill("darwin", 4321, true), { pid: -4321, signal: "SIGKILL" });
    assert.deepEqual(treeKill("win32", 4321, true), { command: ["taskkill", "/pid", "4321", "/T", "/F"] });
    assert.equal(treeKill("linux", undefined), null);
  });
});
