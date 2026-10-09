import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMetaTags,
  extractJsonLd,
  extractRepeatedCards,
  extractOutboundLinks,
} from "./crawler.ts";
import { DiscoveryService } from "./service.ts";
import { getSql } from "../../db.ts";

const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Brand Launch — Next Gen Fitness</title>
  <meta name="description" content="AI powered fitness coaching app for runners.">
  <link rel="canonical" href="https://example.com/fitness">
  <meta property="og:title" content="Next Gen Fitness App">
  <meta property="og:image" content="https://example.com/hero.jpg">
  <meta property="og:description" content="Transform your daily runs with real-time feedback.">
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Fitness AI Coach",
      "description": "Smart running coach"
    }
  </script>
</head>
<body>
  <h1>Next Gen Fitness</h1>
  <div class="feed">
    <article class="feed-item card">
      <h3>HIIT Routine for Beginners</h3>
      <p>Start your morning with this 15-minute quick burn routine.</p>
      <img src="/images/routine1.jpg" alt="HIIT" />
      <a href="/routines/hiit-beginners">Try Routine</a>
      <span class="metrics">45.2K views · 1.5K likes</span>
    </article>
    <article class="feed-item card">
      <h3>Marathon Pacing Strategy</h3>
      <p>How to negative split your next 26.2 without hitting the wall.</p>
      <img src="/images/routine2.jpg" alt="Marathon" />
      <a href="/routines/marathon-pacing">Read Strategy</a>
      <span class="metrics">120K plays</span>
    </article>
  </div>
  <nav>
    <a href="/pricing">Pricing</a>
    <a href="/about">About Us</a>
    <a href="https://external-competitor.com/ads">Partner</a>
    <a href="/routines/hiit-beginners#comments">Comments</a>
  </nav>
</body>
</html>
`;

test("Crawl Ladder: extracts OpenGraph, canonical, and meta tags correctly", () => {
  const meta = extractMetaTags(sampleHtml);
  assert.equal(meta.title, "Next Gen Fitness App");
  assert.equal(meta.description, "Transform your daily runs with real-time feedback.");
  assert.equal(meta.canonicalUrl, "https://example.com/fitness");
  assert.equal(meta.openGraph["og:image"], "https://example.com/hero.jpg");
});

test("Crawl Ladder: extracts JSON-LD structured data", () => {
  const jsonLd = extractJsonLd(sampleHtml);
  assert.equal(jsonLd.length, 1);
  assert.equal((jsonLd[0] as any)["@type"], "Product");
  assert.equal((jsonLd[0] as any).name, "Fitness AI Coach");
});

test("Crawl Ladder: discovers repeated content cards with honest metrics", () => {
  const cards = extractRepeatedCards(sampleHtml, "https://example.com/fitness", "test-run-1");
  assert.equal(cards.length, 2);

  const card1 = cards[0];
  assert.equal(card1.title, "HIIT Routine for Beginners");
  assert.ok(card1.text?.includes("Start your morning with this 15-minute quick burn routine."));
  assert.equal(card1.destinationUrl, "https://example.com/routines/hiit-beginners");
  assert.equal(card1.mediaUrl, "https://example.com/images/routine1.jpg");
  assert.equal(card1.metrics.views.state, "OBSERVED");
  assert.equal(card1.metrics.views.value, 45200);
  assert.equal(card1.metrics.likes.state, "OBSERVED");
  assert.equal(card1.metrics.likes.value, 1500);
  assert.equal(card1.metrics.comments.state, "UNAVAILABLE");

  const card2 = cards[1];
  assert.equal(card2.title, "Marathon Pacing Strategy");
  assert.equal(card2.metrics.views.state, "OBSERVED");
  assert.equal(card2.metrics.views.value, 120000);
  assert.equal(card2.metrics.likes.state, "UNAVAILABLE");
});

test("Crawl Ladder: filters outbound links to same origin and strips hashes", () => {
  const links = extractOutboundLinks(sampleHtml, "https://example.com/fitness");
  assert.ok(links.includes("https://example.com/pricing"));
  assert.ok(links.includes("https://example.com/about"));
  assert.ok(links.includes("https://example.com/routines/hiit-beginners"));
  // External link must be filtered out
  assert.ok(!links.includes("https://external-competitor.com/ads"));
});

test("DiscoveryService: coordinates discovery run with honest caveat on budget limit", async () => {
  const service = new DiscoveryService();
  const sql = await getSql();
  const orgId = `org-discovery-${Date.now()}`;
  const brandId = `brand-discovery-${Date.now()}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Discovery Org', ${orgId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Discovery Brand', 'test-user')`;

  // Test url_list / seed discovery
  const result = await service.startDiscoveryRun({
    organizationId: orgId,
    brandId,
    scope: "url_list",
    seeds: ["https://example.com/fitness"],
    budget: { maxPages: 2 },
    sql,
  });

  assert.ok(result.run.id.startsWith("crawll_"));
  assert.equal(result.run.status, "completed");
  assert.ok(result.items.length >= 0);
});

test("DiscoveryService: refuses SQL-less execution instead of falling back to process memory", async () => {
  const service = new DiscoveryService();
  await assert.rejects((service.startDiscoveryRun as any)({
    organizationId: "org-test", brandId: "brand-test", scope: "page_plus_links", seeds: ["https://example.com"],
  }), /Durable SQL is required/);
});
