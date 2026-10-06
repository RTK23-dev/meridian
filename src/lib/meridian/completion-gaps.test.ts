import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PNG } from "pngjs";
import { embedWithProvider } from "./embeddings/select.ts";
import { whitespaceFromClusters } from "./intelligence/semantic-gap.ts";
import type { MarketCluster } from "./intelligence/whitespace.ts";
import { acceptInvitation, createInvitation, hashInviteToken } from "./notifications/invite.ts";
import { testEmailProvider } from "./notifications/email.ts";
import { rankOpportunities } from "./opportunity/engine.ts";
import { assessPublishing } from "./publishing/readiness.ts";
import { classifyDuplicate, judgeMedia } from "./studio/features.ts";
import type { Sql } from "./learning/store.ts";
import { measureLogo, measurePalette } from "./vision/measure.ts";
import { pollXaiVideo, submitXaiVideo } from "./video/xai.ts";
import type { BrainSlice, ObservedCreative } from "./domain.ts";

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = paint(x, y);
      const index = (width * y + x) * 4;
      image.data[index] = red;
      image.data[index + 1] = green;
      image.data[index + 2] = blue;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const brain: BrainSlice = {
  positioning: "Cold process soap with a visible lather ritual and proof.",
  differentiators: "",
  problems: "",
  desires: "",
  objections: "",
  tone: "plain",
  wordsToAvoid: "",
  preferredFormats: "short ugc",
  prohibitedClaims: "",
  requiredDisclaimers: "",
  targetCustomers: "people who buy soap",
  valueProposition: "Show the lather ritual.",
};

function creative(id: string, angle: string): ObservedCreative {
  return {
    id,
    organizationId: "org",
    brandId: "brand",
    origin: "competitor",
    angle,
    hookType: "demonstration",
    format: "short_ugc",
    proofType: "demo",
    offer: "",
    cta: "Shop",
    visualStyle: "",
    platform: "paid_social",
    emotion: "",
    productName: "Bar",
    claim: "",
    text: `${angle} creative ${id}`,
  };
}

test("an underserved semantic cluster becomes a ranked opportunity", () => {
  const clusters: MarketCluster[] = [
    {
      id: "cluster-1",
      label: "discount",
      memberIds: ["c1", "c2", "c3"],
      competitorCount: 3,
      ownCount: 1,
      summary: "crowded",
    },
    {
      id: "cluster-2",
      label: "lather ritual",
      memberIds: ["c4", "c5"],
      competitorCount: 2,
      ownCount: 0,
      summary: "open",
    },
  ];
  const findings = whitespaceFromClusters({ clusters, brandText: brain.positioning });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "cluster-2");
  const ranked = rankOpportunities({
    organizationId: "org",
    brandId: "brand",
    brain,
    products: [{ id: "p", name: "Bar", description: "", allowedClaims: "", prohibitedClaims: "" }],
    creatives: [creative("c4", "other"), creative("c5", "other")],
    patterns: [],
    rejections: [],
    clusters,
  });
  const found = ranked.find((item) => item.hypothesisId === "cluster:cluster-2");
  assert.ok(found);
  assert.equal(found?.source, "discovered");
  assert.ok(found?.evidence.some((item) => item.id === "cluster-2" && item.source === "creative_embeddings"));
  assert.deepEqual(found?.supportingCreativeIds, ["c4", "c5"]);
});

test("duplicate bands separate exact, paraphrase, related, and novel", () => {
  const own = "we already ran this exact offer line for the bar";
  assert.equal(classifyDuplicate(own, [own], 0.2), "exact");
  assert.equal(classifyDuplicate("a different sentence about soap craft", [own], 0.96), "near");
  assert.equal(classifyDuplicate("a different sentence about soap craft", [own], 0.86), "paraphrase");
  assert.equal(classifyDuplicate("a different sentence about soap craft", [own], 0.7), "related");
  assert.equal(classifyDuplicate("a different sentence about soap craft", [own], 0.2), "novel");
  const near = judgeMedia({
    kind: "image",
    positioning: brain.positioning,
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Bar",
    angle: "lather_ritual",
    copy: "a different sentence about soap craft",
    prompt: "still",
    competitorTexts: [],
    ownTexts: [own],
    mime: "image/png",
    byteSize: 80,
    width: 32,
    height: 32,
    checksum: "abc123def4567890",
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: null,
    paletteDistance: null,
    semanticSimilarity: null,
    ownSemanticSimilarity: 0.97,
  });
  assert.equal(near.find((item) => item.questionId === "duplicate_risk")?.decision, "REJECT");
  const related = judgeMedia({
    kind: "image",
    positioning: brain.positioning,
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Bar",
    angle: "lather_ritual",
    copy: "a different sentence about soap craft",
    prompt: "still",
    competitorTexts: [],
    ownTexts: [own],
    mime: "image/png",
    byteSize: 80,
    width: 32,
    height: 32,
    checksum: "abc123def4567890",
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: null,
    paletteDistance: null,
    semanticSimilarity: null,
    ownSemanticSimilarity: 0.86,
  });
  assert.notEqual(related.find((item) => item.questionId === "duplicate_risk")?.decision, "REJECT");
});

test("logo and palette decisions come from png bytes", () => {
  const mark = png(32, 32, (x) => (x < 16 ? [10, 10, 10] : [240, 240, 240]));
  const same = png(32, 32, (x) => (x < 16 ? [10, 10, 10] : [240, 240, 240]));
  const other = png(32, 32, (x) => (x < 16 ? [240, 240, 240] : [10, 10, 10]));
  const matched = measureLogo(mark, same);
  assert.equal(matched.outcome, "MATCH");
  assert.ok((matched.similarity ?? 0) > 0.8);
  const missed = measureLogo(mark, other);
  assert.equal(missed.outcome, "MISMATCH");
  const uncertain = measureLogo(mark, new Uint8Array([1, 2, 3, 4]));
  assert.equal(uncertain.outcome, "UNCERTAIN");
  assert.equal(uncertain.similarity, null);
  const close = measurePalette("#142850", png(32, 32, () => [20, 40, 80]));
  assert.equal(close.outcome, "MATCH");
  const far = measurePalette("#142850", png(32, 32, () => [255, 0, 180]));
  assert.equal(far.outcome, "MISMATCH");
  const mixed = measurePalette(
    "#142850",
    png(32, 32, (x) => (x < 16 ? [20, 40, 80] : [255, 230, 0])),
  );
  assert.equal(mixed.outcome, "UNCERTAIN");
  const logoDecision = judgeMedia({
    kind: "image",
    positioning: brain.positioning,
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Bar",
    angle: "lather",
    copy: "Show the bar.",
    prompt: "still",
    competitorTexts: [],
    ownTexts: [],
    mime: "image/png",
    byteSize: mark.byteLength,
    width: 32,
    height: 32,
    checksum: "abc123def4567890",
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: missed.similarity,
    logoOutcome: missed.outcome,
    logoEvidence: missed.evidence,
    paletteDistance: far.distance,
    paletteOutcome: far.outcome,
    paletteEvidence: far.evidence,
    semanticSimilarity: null,
  });
  assert.equal(logoDecision.find((item) => item.questionId === "logo_match")?.decision, "REJECT");
  assert.equal(logoDecision.find((item) => item.questionId === "palette_match")?.decision, "REJECT");
  const unsure = judgeMedia({
    kind: "image",
    positioning: brain.positioning,
    tone: "plain",
    prohibited: "",
    wordsToAvoid: "",
    productName: "Bar",
    angle: "lather",
    copy: "Show the bar.",
    prompt: "still",
    competitorTexts: [],
    ownTexts: [],
    mime: "image/png",
    byteSize: 4,
    width: 32,
    height: 32,
    checksum: "abc123def4567890",
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: null,
    logoOutcome: "UNCERTAIN",
    logoEvidence: uncertain.evidence,
    paletteDistance: mixed.distance,
    paletteOutcome: "UNCERTAIN",
    paletteEvidence: mixed.evidence,
    semanticSimilarity: null,
  });
  assert.equal(unsure.find((item) => item.questionId === "logo_match")?.decision, "HUMAN_REVIEW");
  assert.equal(unsure.find((item) => item.questionId === "palette_match")?.decision, "HUMAN_REVIEW");
});

test("publishing readiness uses the stored account, not an environment variable", () => {
  const missing = assessPublishing({
    accounts: [],
    provider: "meta",
    kind: "image",
    mime: "image/png",
    width: 1080,
    height: 1080,
    byteSize: 1000,
    destinationUrl: "https://brand.example/shop",
  });
  assert.equal(missing.state, "EXTERNAL_CONNECTION_REQUIRED");
  const ready = assessPublishing({
    accounts: [{ provider: "google", status: "CONNECTED", accountId: "123", permissions: ["ads.write"], pageId: "", destinationUrl: "" }],
    provider: "google",
    kind: "image",
    mime: "image/png",
    width: 1080,
    height: 1080,
    byteSize: 1000,
    destinationUrl: "https://brand.example/shop",
  });
  assert.equal(ready.state, "READY");
  const page = assessPublishing({
    accounts: [{ provider: "meta", status: "CONNECTED", accountId: "act", permissions: [], pageId: "", destinationUrl: "" }],
    provider: "meta",
    kind: "image",
    mime: "image/png",
    width: 1080,
    height: 1080,
    byteSize: 1000,
    destinationUrl: "https://brand.example/shop",
  });
  assert.equal(page.state, "NOT_READY");
});

test("external semantic does not invent a vector", async () => {
  await assert.rejects(() => embedWithProvider("external:semantic", ["soap"]), /not connected/);
  await assert.rejects(
    () =>
      embedWithProvider("external:semantic", ["soap"], {
        env: { url: "https://embed.example/v1/embeddings", key: "secret", model: "m", dimensions: 8 },
        transport: async () => ({ status: 200, body: JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), headers: {} }),
      }),
    /failed validation|dimensions/,
  );
  const vectors = await embedWithProvider("external:semantic", ["soap"], {
    env: { url: "https://embed.example/v1/embeddings", key: "secret", model: "m", dimensions: 8 },
    transport: async () => ({
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
      headers: {},
    }),
  });
  assert.equal(vectors[0]?.provider, "external:semantic");
  assert.equal(vectors[0]?.kind, "semantic");
});

test("xai video stores bytes only after the provider returns them", async () => {
  const missing = await submitXaiVideo({ prompt: "bar", apiKey: "" });
  assert.equal(missing.status, "not_connected");
  assert.equal(missing.bytes, null);
  const calls: string[] = [];
  const submitted = await submitXaiVideo({
    prompt: "bar",
    apiKey: "key",
    transport: async (request) => {
      calls.push(request.url);
      return { status: 200, body: JSON.stringify({ request_id: "req-1" }), headers: {} };
    },
  });
  assert.equal(submitted.providerJobId, "req-1");
  assert.equal(submitted.bytes, null);
  const pending = await pollXaiVideo(submitted, {
    apiKey: "key",
    transport: async () => ({ status: 200, body: JSON.stringify({ status: "pending" }), headers: {} }),
  });
  assert.equal(pending.status, "processing");
  assert.equal(pending.bytes, null);
  const clip = new Uint8Array(32);
  clip.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);
  const done = await pollXaiVideo(submitted, {
    apiKey: "key",
    transport: async () => ({
      status: 200,
      body: JSON.stringify({ status: "done", video: { url: "https://vidgen.x.ai/clip.mp4", duration: 6 } }),
      headers: {},
    }),
    download: async () => clip,
  });
  assert.equal(done.status, "completed");
  assert.equal(done.bytes?.byteLength, 32);
  const broken = await pollXaiVideo(submitted, {
    apiKey: "key",
    transport: async () => ({ status: 200, body: JSON.stringify({ status: "done", video: {} }), headers: {} }),
  });
  assert.equal(broken.status, "failed");
  assert.equal(broken.bytes, null);
  assert.ok(calls.every((url) => url.startsWith("https://api.x.ai/")));
});

test("an invitation email is one-time and does not keep the raw token", async () => {
  const invites: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const sent: { to: string; subject: string; text: string }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("insert into invites")) {
      invites.push({
        id: values[0],
        organization_id: values[1],
        email: values[2],
        role: values[3],
        status: "pending",
        token_hash: values[5],
        expires_at: values[6],
        sent_at: null,
      });
      return [];
    }
    if (text.includes("set status = 'sent'")) {
      const row = invites.find((item) => item.id === values[0]);
      if (row) row.status = "sent";
      return [];
    }
    if (text.includes("set status = 'accepted'")) {
      const row = invites.find((item) => item.id === values[0] && item.token_hash === values[1]);
      if (row) {
        row.status = "accepted";
        row.token_hash = "";
      }
      return [];
    }
    if (text.includes("from invites")) {
      return invites.filter((item) => item.token_hash === values[0]);
    }
    if (text.includes("from memberships")) return memberships.filter((item) => item.user_id === values[1]);
    if (text.includes("insert into memberships")) {
      memberships.push({ id: values[0], organization_id: values[1], user_id: values[2], role: values[3] });
      return [];
    }
    if (text.includes("set status = 'accepted'")) {
      const row = invites.find((item) => item.id === values[0] && item.token_hash === values[1]);
      if (row) {
        row.status = "accepted";
        row.token_hash = "";
      }
      return [];
    }
    return [];
  }) as Sql;
  sql.query = async () => [];
  const provider = testEmailProvider(sent);
  await createInvitation(sql, {
    id: "inv",
    organizationId: "org",
    email: "a@example.com",
    role: "member",
    createdBy: "owner",
    workspaceName: "Soap",
    origin: "https://app.example",
    provider,
  });
  assert.equal(invites[0]?.status, "sent");
  assert.equal(sent.length, 1);
  const token = sent[0]?.text.match(/token=([^ ]+)/)?.[1] ?? "";
  assert.ok(token);
  assert.notEqual(invites[0]?.token_hash, token);
  assert.equal(invites[0]?.token_hash, hashInviteToken(decodeURIComponent(token)));
  assert.equal(sent[0]?.text.includes(String(invites[0]?.token_hash)), false);
  const accepted = await acceptInvitation(sql, { token: decodeURIComponent(token), userId: "user", userEmail: "a@example.com" });
  assert.equal(accepted.organizationId, "org");
  await assert.rejects(
    () => acceptInvitation(sql, { token: decodeURIComponent(token), userId: "user", userEmail: "a@example.com" }),
    /invalid/,
  );
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
});
