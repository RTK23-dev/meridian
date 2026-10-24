import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/*
 * Black-box tests for the bridge. Each test runs scripts/hypit-bridge.mjs as its own process on a free loopback port.
 * The CLI is either a path that does not exist or a fake shell script in a temp folder. The real Hypit CLI is never
 * spawned, and no test calls anything beyond the loopback address the bridge listens on. Every secret is fake.
 */
const bridgeFile = join(dirname(fileURLToPath(import.meta.url)), "hypit-bridge.mjs");
const FAKE_TOKEN = "fake-token-for-tests-only";
const FAKE_DATABASE_URL = "postgres://fake-user@fake.invalid/meridian";
const FAKE_OTHER_SECRET = "fake-other-secret-for-tests-only";

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "hypit-bridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake `hypit` (or ffprobe) that runs the given shell body. It runs inside the job folder. */
async function fakeCli(dir, body) {
  const file = join(dir, "fake-hypit");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** A loopback port that was free a moment ago. The bridge binds it right after, so the window is short. */
async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

async function accepting(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Starts the bridge as a child process and resolves once it accepts connections on its host and port. */
async function startBridge(t, dir, env = {}) {
  const port = await freePort();
  const host = env.HYPIT_BRIDGE_HOST || "127.0.0.1";
  const jobRoot = join(dir, "jobs");
  let output = "";
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HYPIT_BRIDGE_PORT: String(port),
      HYPIT_JOB_ROOT: jobRoot,
      HYPIT_BIN: join(dir, "no-such-hypit"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const deadline = Date.now() + 10_000;
  while (!(await accepting(host, port))) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      assert.fail(`bridge is not accepting connections on ${host}:${port}: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, host, port, base: `http://${host}:${port}`, jobRoot };
}

async function call(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function jobContract(overrides = {}) {
  return {
    schema: "meridian.hypit.job.v1",
    meridianJobId: "job-test-0001",
    product: "Tea",
    angle: "Calm mornings",
    cta: "Try it today",
    aspectRatio: "9:16",
    durationSeconds: 15,
    ...overrides,
  };
}

test("a missing hypit binary fails the job, and the bridge keeps answering", async (t) => {
  const dir = await workspace(t);
  const bridge = await startBridge(t, dir, { HYPIT_BIN: join(dir, "no-such-hypit") });

  const health = await call(bridge.base, "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.provider, "hypit");
  assert.ok(!health.text.includes(dir), "the answer must not name the binary path or the folders");

  const created = await call(bridge.base, "/v1/jobs", { method: "POST", body: jobContract() });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, "failed");
  assert.match(created.json.error, /could not be started/);
  assert.ok(!created.text.includes(dir), "the job error must not name the binary path or the folders");

  const job = await call(bridge.base, `/v1/jobs/${encodeURIComponent(created.json.providerJobId)}`);
  assert.equal(job.json.status, "failed");

  assert.equal(bridge.child.exitCode, null, "the bridge process must still be running");
  assert.equal((await call(bridge.base, "/health")).status, 503);
});

test("a missing ffprobe fails the job, and the bridge keeps answering", async (t) => {
  const dir = await workspace(t);
  // A fake CLI that completes check, build and get, so the bridge reaches the probe step. The export is a fake MP4 header.
  const cli = await fakeCli(
    dir,
    `case "$1" in
  --version) echo "hypit 0.0.0-test"; exit 0 ;;
  check) exit 0 ;;
  build) echo "built bld_fake01"; exit 0 ;;
  get) while [ $# -gt 0 ]; do if [ "$1" = "--to" ]; then target="$2"; fi; shift; done; printf 'xxxxxxxxftypmp42' > "$target"; exit 0 ;;
esac
exit 1`,
  );
  const bridge = await startBridge(t, dir, { HYPIT_BIN: cli, HYPIT_FFPROBE: join(dir, "no-such-ffprobe") });
  const created = await call(bridge.base, "/v1/jobs", { method: "POST", body: jobContract({ meridianJobId: "job-probe-0001" }) });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, "failed");
  assert.match(created.json.error, /ffprobe could not be started/);
  assert.ok(!created.text.includes(dir), "the job error must not name the ffprobe path or the folders");
  assert.equal(bridge.child.exitCode, null, "the bridge process must still be running");
  assert.equal((await call(bridge.base, "/health")).status, 200);
});

test("a duration outside 1 to 60 seconds is refused with 400 before the CLI starts", async (t) => {
  const dir = await workspace(t);
  const marker = join(dir, "cli-started");
  const cli = await fakeCli(dir, `: > '${marker}'\nexit 1`);
  const bridge = await startBridge(t, dir, { HYPIT_BIN: cli });

  const refused = [0, -1, 61, 1000, "30", null, undefined];
  for (const [index, durationSeconds] of refused.entries()) {
    const id = `job-duration-bad-${index}`;
    const response = await call(bridge.base, "/v1/jobs", {
      method: "POST",
      body: jobContract({ meridianJobId: id, durationSeconds }),
    });
    assert.equal(response.status, 400, `durationSeconds ${String(durationSeconds)} must be refused`);
    assert.match(response.json.error, /durationSeconds/);
    await assert.rejects(stat(join(bridge.jobRoot, id)), { code: "ENOENT" });
  }
  await assert.rejects(stat(marker), { code: "ENOENT" }, "no refused job may start the CLI");

  for (const [index, durationSeconds] of [1, 60].entries()) {
    const response = await call(bridge.base, "/v1/jobs", {
      method: "POST",
      body: jobContract({ meridianJobId: `job-duration-ok-${index}`, durationSeconds }),
    });
    assert.equal(response.status, 200, `durationSeconds ${durationSeconds} is in range`);
  }
});

test("product, angle and CTA text is XML-escaped in the SVML headline", async (t) => {
  const dir = await workspace(t);
  const cli = await fakeCli(dir, "exit 1");
  const bridge = await startBridge(t, dir, { HYPIT_BIN: cli });
  const cases = [
    {
      id: "job-xml-plain",
      product: "Tea & Honey <Pro>",
      angle: `"Calm" it's`,
      cta: "Shop > now",
      expected: "Tea &amp; Honey &lt;Pro&gt; · &quot;Calm&quot; it&apos;s · Shop &gt; now",
    },
    {
      // 179 letters, then three ampersands. The 180-character cut lands on an ampersand, and must not split an entity.
      id: "job-xml-edge",
      product: `${"a".repeat(179)}&&&`,
      angle: "b",
      cta: "c",
      expected: `${"a".repeat(179)}&amp;`,
    },
  ];
  for (const item of cases) {
    const response = await call(bridge.base, "/v1/jobs", {
      method: "POST",
      body: jobContract({ meridianJobId: item.id, product: item.product, angle: item.angle, cta: item.cta }),
    });
    assert.equal(response.status, 200);
    const svml = await readFile(join(bridge.jobRoot, item.id, "main.svml"), "utf8");
    const headline = svml.match(/<typo:Area id="headline"[^>]*>([\s\S]*?)<\/typo:Area>/);
    assert.ok(headline, "the headline element must be in main.svml");
    assert.equal(headline[1], item.expected);
    assert.doesNotMatch(headline[1], /&(?!(amp|lt|gt|quot|apos);)/, "no bare ampersand may remain");
  }
});

test("the CLI receives only the allowlisted environment, never the bridge's secrets", async (t) => {
  const dir = await workspace(t);
  const cli = await fakeCli(dir, "env > child-env.txt\nexit 1");
  const bridge = await startBridge(t, dir, {
    HYPIT_BIN: cli,
    HYPIT_API_TOKEN: FAKE_TOKEN,
    DATABASE_URL: FAKE_DATABASE_URL,
    FAKE_OTHER_SECRET,
    HOME: dir,
    LANG: "C.UTF-8",
    TMPDIR: dir,
  });
  const response = await call(bridge.base, "/v1/jobs", {
    method: "POST",
    token: FAKE_TOKEN,
    body: jobContract({ meridianJobId: "job-env-0001" }),
  });
  assert.equal(response.status, 200);

  const seen = await readFile(join(bridge.jobRoot, "job-env-0001", "child-env.txt"), "utf8");
  for (const secret of [FAKE_TOKEN, FAKE_DATABASE_URL, FAKE_OTHER_SECRET]) {
    assert.ok(!seen.includes(secret), "a bridge secret reached the CLI environment");
  }
  const names = seen.split("\n").filter(Boolean).map((line) => line.slice(0, line.indexOf("=")));
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    assert.ok(names.includes(name), `${name} is allowlisted and must reach the CLI`);
  }
  // The shell adds these itself. Everything else must be on the allowlist.
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PWD", "OLDPWD", "SHLVL", "_"];
  assert.deepEqual(names.filter((name) => !allowed.includes(name)), []);
});

test("the bridge binds 127.0.0.1 by default, not all interfaces", async (t) => {
  const dir = await workspace(t);
  const cli = await fakeCli(dir, 'echo "hypit 0.0.0-test"\nexit 0');
  const bridge = await startBridge(t, dir, { HYPIT_BIN: cli });
  const health = await call(bridge.base, "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { provider: "hypit", version: "hypit 0.0.0-test" });
  // 127.0.0.2 is another loopback address. A bridge bound to 0.0.0.0 would answer there; a bridge bound to 127.0.0.1 would not.
  assert.equal(await accepting("127.0.0.2", bridge.port), false, "the default bind must not reach 0.0.0.0");
});

test(
  "HYPIT_BRIDGE_HOST sets the address the bridge binds",
  { skip: process.platform === "darwin" && "127.0.0.2 is not a loopback alias macOS configures by default" },
  async (t) => {
    const dir = await workspace(t);
    const cli = await fakeCli(dir, 'echo "hypit 0.0.0-test"\nexit 0');
    const bridge = await startBridge(t, dir, { HYPIT_BIN: cli, HYPIT_BRIDGE_HOST: "127.0.0.2" });
    assert.equal(bridge.host, "127.0.0.2");
    const health = await call(bridge.base, "/health");
    assert.equal(health.status, 200);
  },
);

test("a job id that is not one plain folder name is refused before anything is written", async (t) => {
  const dir = await workspace(t);
  const cli = await fakeCli(dir, 'echo "ran"\nexit 0');
  const bridge = await startBridge(t, dir, { HYPIT_BIN: cli });
  const unsafe = ["../escape", "a/b", "a\\b", "job id", "", "x".repeat(101), "job.name"];
  for (const id of unsafe) {
    const response = await call(bridge.base, "/v1/jobs", { method: "POST", body: jobContract({ meridianJobId: id }) });
    assert.equal(response.status, 400, `job id ${JSON.stringify(id)} must be refused`);
    assert.match(response.json.error, /meridianJobId/);
  }
  await assert.rejects(stat(join(dir, "escape")), { code: "ENOENT" }, "a traversal id must not create a folder outside the job root");
  await assert.rejects(stat(join(bridge.jobRoot, "..", "escape")), { code: "ENOENT" });
});

test("a non-loopback bind address without HYPIT_API_TOKEN does not start the bridge", async (t) => {
  const dir = await workspace(t);
  const child = spawn(process.execPath, [bridgeFile], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HYPIT_BRIDGE_PORT: String(await freePort()), HYPIT_JOB_ROOT: join(dir, "jobs"), HYPIT_BRIDGE_HOST: "0.0.0.0", HYPIT_BIN: join(dir, "no-such-hypit") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /HYPIT_API_TOKEN must be set/);
});

