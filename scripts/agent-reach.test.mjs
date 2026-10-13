import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentReachArgs } from "./agent-reach.mjs";

test("with no command the wrapper runs the read-only check", () => {
  assert.deepEqual(buildAgentReachArgs([]), ["-c", "from agent_reach.cli import main; main()", "install", "--env=auto"]);
  assert.deepEqual(buildAgentReachArgs(["install", "--dry-run"]), ["-c", "from agent_reach.cli import main; main()", "install", "--dry-run", "--env=auto"]);
});

test("system changes need --approve-system as well as --system, and the wrapper flag never reaches the tool", () => {
  assert.throws(() => buildAgentReachArgs(["install", "--system"]), /--approve-system/);
  assert.throws(() => buildAgentReachArgs(["install", "--approve-system"]), /only applies together/);
  assert.deepEqual(
    buildAgentReachArgs(["install", "--system", "--approve-system", "--channels=open", "--env=server"]),
    ["-c", "from agent_reach.cli import main; main()", "install", "--system", "--channels=open", "--env=server"],
  );
});

test("proxy and other host-level options are refused here, so they are configured on the host by the operator", () => {
  assert.throws(() => buildAgentReachArgs(["install", "--proxy=http://x"]), /Proxy and cookie settings/);
  assert.throws(() => buildAgentReachArgs(["install", "--sudo"]), /unsupported option/);
});

test("only install and doctor run through the wrapper", () => {
  assert.deepEqual(buildAgentReachArgs(["doctor", "--json"]), ["-c", "from agent_reach.cli import main; main()", "doctor", "--json"]);
  assert.throws(() => buildAgentReachArgs(["configure", "twitter-cookies"]), /does not run through this wrapper/);
  assert.throws(() => buildAgentReachArgs(["uninstall"]), /does not run through this wrapper/);
  assert.throws(() => buildAgentReachArgs(["doctor", "--force"]), /Unknown option for doctor/);
});
