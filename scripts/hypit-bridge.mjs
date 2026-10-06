/**
 * Separate process in front of the installed Hypit CLI.
 * It does not contain Hypit source. It does not call xAI or test:video.
 * A job is succeeded only after `hypit build` exports a real MP4.
 *
 * Single-organization proof runner. Not a multi-tenant Hypit service.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hypitBin = process.env.HYPIT_BIN || "hypit";
const ffmpegPath = process.env.HYPIT_FFMPEG || "/usr/local/bin/ffmpeg";
const ffprobePath = process.env.HYPIT_FFPROBE || "ffprobe";
const port = Number(process.env.HYPIT_BRIDGE_PORT || "8766");
const token = (process.env.HYPIT_API_TOKEN || "").trim();
const root = process.env.HYPIT_JOB_ROOT || "/tmp/hypit-bridge-jobs";

const jobs = new Map();

function xmlText(value) {
  let text = "";
  for (const char of String(value ?? "")) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    text += char;
  }
  return text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/\s+/g, " ").trim();
}

function canvasFor(aspect) {
  if (aspect === "16:9") return [640, 360];
  if (aspect === "1:1") return [360, 360];
  if (aspect === "3:2") return [540, 360];
  if (aspect === "2:3") return [360, 540];
  if (aspect === "4:5") return [360, 450];
  return [360, 640];
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(hypitBin, args, { cwd, env: process.env });
    let out = "";
    let err = "";
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
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function probe(file) {
  const child = spawn(ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration,codec_name",
    "-of", "json",
    file,
  ]);
  let out = "";
  for await (const chunk of child.stdout) out += chunk;
  const parsed = JSON.parse(out || "{}");
  const stream = parsed.streams?.[0] ?? {};
  const duration = Number(stream.duration);
  return {
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "",
  };
}

async function renderJob(contract) {
  const dir = join(root, contract.meridianJobId);
  await mkdir(dir, { recursive: true });
  const [width, height] = canvasFor(contract.aspectRatio);
  const seconds = contract.durationSeconds;
  const line = xmlText([contract.product, contract.angle, contract.cta].filter(Boolean).join(" · ")).slice(0, 180);
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

function authorized(request) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

const server = createServer(async (request, response) => {
  try {
    if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      const version = await run(["--version"], root);
      return send(response, 200, { provider: "hypit", version: version.out.trim() });
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      const raw = await readBody(request);
      const contract = JSON.parse(raw);
      const key = String(request.headers["idempotency-key"] || contract.meridianJobId || "");
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
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

await mkdir(root, { recursive: true });
server.requestTimeout = 0;
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Hypit bridge listening on http://127.0.0.1:${port}\n`);
});
