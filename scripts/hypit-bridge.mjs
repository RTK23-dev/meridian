/**
 * Separate process in front of the installed Hypit CLI.
 * It does not contain Hypit source. It does not call xAI or test:video.
 * A job is succeeded only after `hypit build` exports a real MP4.
 *
 * Single-organization proof runner. Not a multi-tenant Hypit service.
 *
 * Listens on HYPIT_BRIDGE_HOST (default 127.0.0.1). HYPIT_API_TOKEN is required on every address: every request must carry
 * it as a Bearer token, and a request with an Origin header (a browser page) is refused.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hypitBin = process.env.HYPIT_BIN || "hypit";
const ffmpegPath = process.env.HYPIT_FFMPEG || "/usr/local/bin/ffmpeg";
const ffprobePath = process.env.HYPIT_FFPROBE || "ffprobe";
const port = Number(process.env.HYPIT_BRIDGE_PORT || "8766");
const host = (process.env.HYPIT_BRIDGE_HOST || "").trim() || "127.0.0.1";
const token = (process.env.HYPIT_API_TOKEN || "").trim();

/** Loopback addresses. Any other bind address serves other machines too, so it needs HYPIT_API_TOKEN. */

/** A job id names a folder under HYPIT_JOB_ROOT, so it is one plain segment: no separators, no dots, no spaces. */
const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;
const root = process.env.HYPIT_JOB_ROOT || "/tmp/hypit-bridge-jobs";

const jobs = new Map();

/** The contract's duration range (src/lib/meridian/hypit/contract.ts), checked before any file is written or the CLI starts. */
function validDuration(value) {
  return Number.isFinite(value) && value >= 1 && value <= 60;
}

const XML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Plain text: control characters dropped, whitespace collapsed, ends trimmed. */
function plainText(value) {
  let text = "";
  for (const char of String(value ?? "")) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    text += char;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Plain text escaped for an XML text node or attribute value, so no input can open a tag or an attribute. */
function xmlText(value) {
  return plainText(value).replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

function startFailure(tool, error) {
  return `${tool} could not be started (${error?.code || "error"}).`;
}

function canvasFor(aspect) {
  if (aspect === "16:9") return [640, 360];
  if (aspect === "1:1") return [360, 360];
  if (aspect === "3:2") return [540, 360];
  if (aspect === "2:3") return [360, 540];
  if (aspect === "4:5") return [360, 450];
  return [360, 640];
}

/**
 * The only variables the spawned Hypit CLI and ffprobe receive. Everything else the bridge was started with stays
 * with the bridge, including HYPIT_API_TOKEN, DATABASE_URL and every other secret.
 * PATH finds the binaries (the CLI may be a Node script). HOME and TMPDIR give it a home and a temp folder.
 * LANG and LC_ALL set the locale.
 * No HYPIT_* name is passed: this repo does not document which of them the CLI reads. Add one here only after the
 * owner confirms it is a setting and not a secret.
 */
const CHILD_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];

function childEnv() {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// The longest one CLI or ffprobe call may run. A call past it is killed and reported as failed, so a stuck job cannot hold the bridge.
const CHILD_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.HYPIT_CHILD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();

// Kills the child and anything it started. The child leads its own process group, so a shell's own children are stopped too, and their open
// output pipes do not hold the bridge.
function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(hypitBin, args, { cwd, env: childEnv(), detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      killTree(child);
      resolve({ code: 124, out, err: "The Hypit CLI did not finish in time, so it was stopped. Nothing was exported." });
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      out += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      err += text;
      process.stderr.write(text);
    });
    // A missing or unrunnable binary emits 'error' and no exit code. Without this listener Node throws and the bridge exits.
    child.on("error", (error) => {
      clearTimeout(deadline);
      resolve({ code: 127, out, err: startFailure("hypit CLI", error) });
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (timedOut) resolve({ code: 124, out, err: "The Hypit CLI did not finish in time, so it was stopped. Nothing was exported." });
      else resolve({ code: code ?? 1, out, err });
    });
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration,codec_name",
      "-of", "json",
      file,
    ], { env: childEnv(), detached: true });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const deadline = setTimeout(() => {
      killTree(child);
      reject(new Error("ffprobe did not finish in time, so it was stopped."));
    }, CHILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(new Error(startFailure("ffprobe", error)));
    });
    child.on("close", () => {
      clearTimeout(deadline);
      try {
        const parsed = JSON.parse(out || "{}");
        const stream = parsed.streams?.[0] ?? {};
        const duration = Number(stream.duration);
        resolve({
          width: Number(stream.width) || null,
          height: Number(stream.height) || null,
          durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
          codec: typeof stream.codec_name === "string" ? stream.codec_name : "",
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function renderJob(contract) {
  const dir = join(root, contract.meridianJobId);
  await mkdir(dir, { recursive: true });
  const [width, height] = canvasFor(contract.aspectRatio);
  const seconds = contract.durationSeconds;
  // Cut the plain text first and escape after, so the cut never splits an entity such as &amp;.
  const line = xmlText(plainText([contract.product, contract.angle, contract.cta].filter(Boolean).join(" · ")).slice(0, 180));
  const runtime = {
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/runtimes/local",
    endpoints: {
      "media.local": {
        use: "@hypit/provider-media-local",
        config: { defaultConcurrency: 1, ffmpegPath, ffprobePath },
      },
      "hyperframes.local": {
        use: "@hypit/provider-hyperframes-local",
        config: { workers: 1, defaultConcurrency: 1, browserGpu: "software" },
      },
    },
  };
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "meridian-hypit-job", private: true, type: "module" }));
  await writeFile(join(dir, "hypit.runtime.json"), JSON.stringify(runtime, null, 2));
  await writeFile(join(dir, "look.svs"), `<?svml using="@hypit/svs@1"?>
<sheet version="1">
  text.title { size: 36; weight: 700; stack-order: 20; }
  film.main { background: #18212A; }
</sheet>
`);
  await writeFile(join(dir, "main.svml"), `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="spatial" from="@hypit/spatial@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="typo" from="@hypit/typography-track@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="style" source="./look.svs"/>
  <time:Clock id="clock" frame-rate="15"/>
  <time:Timeline id="animation" clock={clock} end="${seconds}s"/>
  <spatial:Canvas id="canvas" width="${width}" height="${height}"/>
  <spatial:Frame id="title-frame" within={canvas} left="8%" top="18%" right="92%" bottom="82%"/>
  <fonts:Stack id="font" family="inter" weight="700" style="normal"/>
  <typo:Style id="title-style" recipe={style.text.title} font={font}>
    <typo:Fill color="#F4F1EA"/>
  </typo:Style>
  <typo:Track id="titles" timeline={animation.timeline}>
    <typo:Area id="headline" placement={title-frame} style={title-style} during="program">${line}</typo:Area>
  </typo:Track>
  <film:Film id="main" canvas={canvas} timeline={animation.timeline} appearance={style.film.main}>
    <film:Track source={titles.track}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={animation.timeline}/>
</svml>
`);
  await writeFile(join(dir, "build.svrun"), `<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./main.svml"/>
  <target output="final.video"/>
</svrun>
`);
  const checked = await run(["check", "main.svml", "--workspace", dir], dir);
  if (checked.code !== 0) {
    throw new Error(checked.out || checked.err || "hypit check failed");
  }
  const built = await run(["build", "build.svrun", "--workspace", dir, "--runtime", join(dir, "hypit.runtime.json"), "--follow"], dir);
  const ids = [...built.out.matchAll(/bld_[A-Za-z0-9_]+/g)].map((match) => match[0]);
  const buildId = ids.at(-1) ?? "";
  if (built.code !== 0 || !buildId) {
    throw new Error(built.err || built.out || "hypit build failed");
  }
  const target = join(dir, "final.mp4");
  const exported = await run(["get", buildId, "--output", "final.video", "--workspace", dir, "--to", target], dir);
  if (exported.code !== 0) throw new Error(exported.err || exported.out || "hypit get failed");
  const bytes = await readFile(target);
  if (bytes.byteLength < 16 || !bytes.subarray(0, 32).includes(Buffer.from("ftyp"))) {
    throw new Error("Hypit export did not contain an MP4 container.");
  }
  const facts = await probe(target);
  if (facts.codec !== "h264") throw new Error(`Hypit export codec was ${facts.codec || "missing"}, not h264.`);
  return { buildId, bytes, facts };
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}

/**
 * Every request must carry the bridge's token, on every address, and must not come from a browser. A web page open in the operator's
 * browser can reach a loopback port, so an address check alone is not enough: a page's request carries an Origin header, which is refused.
 * The comparison is constant-time.
 */
function authorized(request) {
  if (request.headers.origin !== undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(String(request.headers.authorization || ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The largest request body the bridge reads. A job contract is a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.origin !== undefined) return send(response, 403, { error: "browser requests are refused" });
    if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      const version = await run(["--version"], root);
      if (version.code !== 0) {
        return send(response, 503, { provider: "hypit", version: "", error: "hypit CLI did not report a version." });
      }
      return send(response, 200, { provider: "hypit", version: version.out.trim() });
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      let contract;
      try {
        contract = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof BodyTooLarge) return send(response, 413, { error: "The request body is larger than 64 KB. Nothing was started." });
        return send(response, 400, { error: "The request body is not valid JSON. Nothing was started." });
      }
      if (!validDuration(contract?.durationSeconds)) {
        return send(response, 400, { error: "durationSeconds must be a finite number from 1 to 60. Nothing was started." });
      }
      const idHeader = String(request.headers["idempotency-key"] || "");
      if (!JOB_ID.test(String(contract.meridianJobId ?? "")) || (idHeader !== "" && !JOB_ID.test(idHeader))) {
        return send(response, 400, { error: "meridianJobId must be 1 to 100 letters, digits, '-' or '_'. Nothing was started." });
      }
      const key = idHeader || contract.meridianJobId;
      const existing = [...jobs.values()].find((job) => job.meridianJobId === key);
      if (existing) return send(response, 200, { providerJobId: existing.providerJobId, status: existing.status, error: existing.error });
      const pendingId = `pending_${key.slice(0, 12) || "job"}`;
      const record = { meridianJobId: key, providerJobId: pendingId, status: "running", error: "", bytes: null, facts: null };
      jobs.set(pendingId, record);
      try {
        const rendered = await renderJob(contract);
        jobs.delete(pendingId);
        const done = {
          meridianJobId: key,
          providerJobId: rendered.buildId,
          status: "succeeded",
          error: "",
          bytes: rendered.bytes,
          facts: rendered.facts,
        };
        jobs.set(rendered.buildId, done);
        return send(response, 200, { providerJobId: done.providerJobId, status: "succeeded" });
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message.slice(0, 500) : "hypit failed";
        return send(response, 200, { providerJobId: record.providerJobId, status: "failed", error: record.error });
      }
    }
    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) return send(response, 404, { error: "unknown job" });
      return send(response, 200, { providerJobId: job.providerJobId, status: job.status, error: job.error });
    }
    const artifactMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifact$/);
    if (request.method === "GET" && artifactMatch) {
      const job = jobs.get(decodeURIComponent(artifactMatch[1]));
      if (!job || job.status !== "succeeded" || !job.bytes) return send(response, 404, { error: "artifact missing" });
      return send(response, 200, {
        mime: "video/mp4",
        base64: Buffer.from(job.bytes).toString("base64"),
        durationMs: job.facts?.durationMs ?? null,
        width: job.facts?.width ?? null,
        height: job.facts?.height ?? null,
      });
    }
    return send(response, 404, { error: "not found" });
  } catch (error) {
    return send(response, 500, { error: error instanceof Error ? error.message : "bridge error" });
  }
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

if (!token) {
  process.stderr.write("HYPIT_API_TOKEN must be set. The bridge did not start. Loopback alone is not enough: a page in the operator's browser can reach it.\n");
  process.exit(1);
}
await mkdir(root, { recursive: true });
server.requestTimeout = 0;
server.listen(port, host, () => {
  const shown = host.includes(":") ? `[${host}]` : host;
  process.stdout.write(`Hypit bridge listening on http://${shown}:${server.address().port}\n`);
});
