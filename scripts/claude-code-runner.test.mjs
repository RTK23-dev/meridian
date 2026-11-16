import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALLOWED_TOOLS, checkedLink, childEnv, claudeArgs, mcpConfig, readEnd, redact, versionOf } from "./claude-code-runner-lib.mjs";

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
    assert.equal(args[args.indexOf("--session-id") + 1], "11111111-1111-4111-8111-111111111111");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--output-format") + 1], "json");
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
    assert.deepEqual(readEnd({ code: 0, signal: null, stdout: JSON.stringify({ result: "Saved file f1", is_error: false }), stderr: "", timedOut: false }), { ok: true, summary: "Saved file f1" });
    assert.equal(readEnd({ code: 0, signal: null, stdout: JSON.stringify({ result: "ran out of turns", is_error: true }), stderr: "", timedOut: false }).ok, false);
    assert.match(readEnd({ code: 1, signal: null, stdout: "", stderr: "not signed in", timedOut: false }).reason, /code 1\. not signed in/);
    assert.match(readEnd({ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true }).reason, /45 minutes/);
    assert.equal(readEnd({ code: 0, signal: null, stdout: "plain text, not JSON", stderr: "", timedOut: false }).ok, true);
    assert.equal(readEnd({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: false }).ok, false);
  });

  test("finds the version number", () => {
    assert.equal(versionOf("2.1.310 (Claude Code)"), "2.1.310");
    assert.equal(versionOf("command not found"), null);
  });
});
