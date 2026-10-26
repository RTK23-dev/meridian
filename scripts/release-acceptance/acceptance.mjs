// The browser acceptance for the release review, run against a local dev server (testing runtime) on the database that
// seed-holds.mjs prepares. It checks the uncertain-hold panel in Settings (the reason gate, keyboard release, focus, the notice, and
// the audit row the release writes), a saved key that reads as saved but not live-verified, stale provider readiness, and blank configuration failing closed.
// No provider request is sent: the key is a fixture, and the run fails if any request leaves the local server.
// Stale readiness is checked below in the real Integrations card with a seeded 25-hour-old success and a fixture-only sealed token.
// run.mjs does the whole sequence (the account, the seed, this pass and the database check); docs/RELEASE_ACCEPTANCE.md describes it.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { localAcceptanceBase } from "./local-base.mjs";

const base = localAcceptanceBase(process.env.ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8080");
const email = process.env.ACCEPTANCE_EMAIL ?? "acceptance-owner@example.com";
const password = process.env.ACCEPTANCE_PASSWORD ?? "AcceptancePass-1";
const out = process.env.ACCEPTANCE_OUT ?? "artifacts/release-acceptance";
mkdirSync(out, { recursive: true });

const results = [];
async function check(id, label, fn) {
  try {
    await fn();
    results.push({ id, label, result: "PASS" });
    console.log(`PASS ${id} ${label}`);
  } catch (error) {
    results.push({ id, label, result: "FAIL", detail: error.message });
    console.log(`FAIL ${id} ${label}: ${error.message}`);
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(30000);
  const external = [];
  const localOrigin = new URL(base).origin;
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== localOrigin) external.push(request.url());
  });

  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"));

  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  const holds = page.locator('[aria-labelledby="uncertain-holds-title"]');
  await holds.waitFor();
  await holds.scrollIntoViewIfNeeded();

  await check("A1", "two uncertain holds are listed with their operation and model", async () => {
    const text = await holds.innerText();
    assert.match(text, /creative_script with anthropic\/claude-haiku-5\.5/);
    assert.match(text, /research_analysis with google\/gemini-2\.5-flash/);
  });

  await check("A2", "a release with no reason is disabled, so nothing can be released without one", async () => {
    const buttons = holds.getByRole("button", { name: "Release this hold" });
    assert.equal(await buttons.count(), 2);
    for (let i = 0; i < 2; i += 1) assert.ok(await buttons.nth(i).isDisabled());
  });
  await page.screenshot({ path: join(out, "holds-desktop-1280.png") });
  await holds.screenshot({ path: join(out, "holds-section-desktop.png") });

  await check("A3", "keyboard: the reason field takes focus, a short reason keeps release disabled, and focus shows a visible ring", async () => {
    const reason = holds.getByLabel("Reason for releasing this hold").first();
    await reason.focus();
    assert.equal(await reason.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.type("Too short");
    const release = holds.getByRole("button", { name: "Release this hold" }).first();
    assert.ok(await release.isDisabled(), "a reason under 10 characters does not enable release");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Checked the provider account: no charge was recorded for this call.");
    assert.equal(await release.isEnabled(), true, "a reason of 10 characters or more enables release");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => ({
      text: document.activeElement?.textContent?.trim(),
      visible: document.activeElement?.matches(":focus-visible") ?? false,
      outline: getComputedStyle(document.activeElement).outlineStyle,
      shadow: getComputedStyle(document.activeElement).boxShadow,
    }));
    assert.equal(focused.text, "Release this hold", "Tab moves focus to the release button");
    assert.equal(focused.visible, true, "the focused button matches :focus-visible");
    assert.ok(focused.outline !== "none" || focused.shadow !== "none", "the focused button draws a ring");
    await page.screenshot({ path: join(out, "holds-focus-on-release.png") });
  });

  await check("A4", "keyboard: Enter releases the hold, the notice names it, and only that hold leaves the list", async () => {
    await page.keyboard.press("Enter");
    const notice = holds.getByRole("status").filter({ hasText: "is released" });
    await notice.waitFor();
    assert.match(await notice.innerText(), /It no longer counts against the month/);
    await page.waitForTimeout(800);
    const remaining = await holds.innerText();
    assert.doesNotMatch(remaining, /creative_script with anthropic\/claude-haiku-5\.5/, "the released hold is gone");
    assert.match(remaining, /research_analysis with google\/gemini-2\.5-flash/, "the other hold is still uncertain");
    await holds.screenshot({ path: join(out, "holds-after-release-desktop.png") });
  });

  await check("A5", "a second, unreleased hold keeps its release disabled", async () => {
    const release = holds.getByRole("button", { name: "Release this hold" });
    assert.equal(await release.count(), 1);
    assert.ok(await release.first().isDisabled());
  });

  await check("B1", "a stored key reads as saved and not checked live, and nothing claims a live verification", async () => {
    const anchor = page.getByText("Gemini perception", { exact: true }).first();
    const row = anchor.locator("xpath=ancestor::li[1]");
    await row.scrollIntoViewIfNeeded();
    let rowText = await row.innerText();
    if (!/Stored key/.test(rowText)) {
      const keyField = row.getByLabel("Gemini perception key");
      await keyField.fill("fixture-gemini-key-not-real");
      await keyField.press("Enter");
      await page.waitForTimeout(2000);
      rowText = await row.innerText();
    }
    assert.match(rowText, /Stored key/, "the saved key is shown by its last characters only");
    assert.match(rowText, /Saved, not checked live/, "the row says the key is saved and not checked live");
    assert.doesNotMatch(rowText, /Usable/, "the row no longer calls a saved key usable");
    assert.doesNotMatch(rowText, /healthy|live verified|verified against|connected and tested/i, "the row never claims a live verification");
    const main = await page.locator("main").innerText();
    assert.match(main, /Nothing is checked against a live provider here\./, "the page says nothing was checked against a live provider");
    await row.screenshot({ path: join(out, "gemini-perception-stored-key-desktop.png") });
  });

  await page.goto(`${base}/integrations`, { waitUntil: "networkidle" });
  await check("C1", "a stored success older than 24 hours is shown as degraded, never healthy or live-verified", async () => {
    const metaCard = page.getByRole("heading", { name: "Meta", exact: true }).locator("xpath=ancestor::li[1]");
    await metaCard.waitFor();
    const cardText = await metaCard.innerText();
    assert.match(cardText, /degraded/i, "the actual Integrations card reports degraded");
    assert.match(cardText, /last successful request is stale/i, "the actual card explains why it is degraded");
    assert.doesNotMatch(cardText, /healthy|live verified|connected and tested/i, "a stale record is never presented as healthy");
  });

  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await page.goto(`${base}/content-factory`, { waitUntil: "networkidle" });
  await check("F1", "Content page exposes the workflow sections with accessible labels and an admin-only Ads tab", async () => {
    const main = await page.locator("main").innerText();
    assert.match(main, /Make, review, publish and learn from your videos, images and ads in one place\./);
    for (const label of ["Create", "Ideas", "Review", "Library", "Publish", "Results", "Ads"]) {
      assert.equal(await page.getByRole("tab", { name: label, exact: true }).count(), 1, `the ${label} tab is available to this admin`);
    }
  });
  await check("F2", "create presets show an unambiguous selected state", async () => {
    const briefPreset = page.getByRole("radio", { name: /Video from a brief/ });
    await briefPreset.waitFor();
    assert.equal(await briefPreset.getAttribute("aria-checked"), "true");
    const studioPreset = page.getByRole("radio", { name: /Images and videos in Studio/ });
    assert.equal(await studioPreset.count(), 1);
    await studioPreset.click();
    assert.equal(await studioPreset.getAttribute("aria-checked"), "true");
    // The workspace has a brand now, so the page offers the session form. It must not claim a brand is missing.
    assert.equal(await page.getByRole("heading", { name: "Create a brand first" }).count(), 0);
  });
  await page.screenshot({ path: join(out, "content-workflow-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/content-factory`, { waitUntil: "networkidle" });
  await check("F3", "Content page fits a phone viewport without horizontal overflow", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `the Content page is ${overflow}px wider than the viewport`);
  });
  await page.screenshot({ path: join(out, "content-workflow-phone-390.png") });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await check("C2", "blank configuration fails closed: the decision engine says it cannot answer", async () => {
    await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
    assert.match(await page.locator("main").innerText(), /cannot answer decisions yet/);
  });

  // The first-run journey of a person who has not read the code: Market, the three outcomes, the sources, the budget and the engine.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  const brandLink = page.getByRole("link", { name: /Acceptance Brand/ }).first();
  await brandLink.waitFor();
  const brandPath = `/brands/${new URL(await brandLink.getAttribute("href"), base).pathname.match(/\/brands\/([^/]+)/)[1]}`;
  await page.goto(`${base}${brandPath}/market`, { waitUntil: "networkidle" });
  const runsBlock = page.getByText("Recent discovery runs").locator("..");
  await runsBlock.waitFor().catch(async (error) => {
    await page.screenshot({ path: join(out, "market-not-found.png"), fullPage: true });
    throw new Error(`${error.message.split("\n")[0]} at ${page.url()}: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  });

  await check("G1", "Market tells a person how to start: one exact page URL needs no setup, and a phrase search is a separate, optional thing", async () => {
    const main = await page.locator("main").innerText();
    assert.match(main, /Paste a public page URL\./);
    assert.match(main, /No setup or key is needed/);
    assert.match(main, /Or search by phrase\./);
    assert.match(main, /It is optional/);
    assert.ok((await page.getByRole("button", { name: /Read this page|Search/ }).count()) > 0);
  });

  await check("G2", "a run that stored new examples says so, and keeps the source rows behind a disclosure", async () => {
    const text = await runsBlock.innerText();
    assert.match(text, /3 new examples stored, 2 already stored/);
    assert.match(text, /New examples/);
    const details = runsBlock.locator("details").first();
    assert.equal(await details.evaluate((node) => node.open), false, "source details must start closed");
  });

  await check("G3", "a duplicate-only run says nothing new was added and offers a next step, and sources not used are not failures", async () => {
    const text = await runsBlock.innerText();
    assert.match(text, /Nothing new\. The page was read, and all 5 of its examples were already stored\./);
    assert.match(text, /add another page URL, or upload an example/);
    assert.match(text, /0 failed, 2 not used/);
  });

  await check("G4", "a robots.txt-blocked page is reported as blocked, is not bypassed, and offers a supported alternative", async () => {
    const text = await runsBlock.innerText();
    assert.match(text, /Blocked/);
    assert.match(text, /robots\.txt does not allow MeridianBot/);
    assert.match(text, /Instagram did not let Meridian read this page/);
    assert.match(text, /no connector in this release, and a key would not change that/);
    assert.match(text, /does not work around the block/);
    assert.match(text, /Upload the post or paste its text/);
  });

  await check("G10", "typing a social URL says up front that there is no connector and no key is used, before anything runs", async () => {
    const input = page.getByPlaceholder(/shop\.example/);
    await input.fill("https://www.instagram.com/p/abc/");
    const note = page.getByText(/Instagram has no connector in this release, and no key is needed or used/);
    await note.waitFor();
    await input.fill("https://shop.example/sponge");
    assert.equal(await page.getByText(/has no connector in this release, and no key is needed or used/).count(), 0);
    await input.fill("");
  });

  await check("G5", "the default Market view prints no per-source rows, and the details open on request", async () => {
    const before = await runsBlock.innerText();
    assert.doesNotMatch(before, /Not used for this input/);
    await runsBlock.locator("details > summary").nth(1).click();
    assert.match(await runsBlock.innerText(), /Not used for this input/);
  });

  await check("G6", "sources: only search sources ask for a key, and the unavailable ones say no key is needed", async () => {
    const main = page.locator("main");
    await main.getByText(/Optional: search by phrase/).click();
    assert.match(await main.innerText(), /your own developer key/);
    assert.match(await main.innerText(), /never needs the password or token of the brand you are studying|none of them needs the password or token of the brand you are studying/);
    await main.getByText(/Not available in this release/).click();
    const text = await main.innerText();
    assert.match(text, /No key is needed for these, and saving one changes nothing/);
    assert.match(text, /Instagram/);
  });
  await page.screenshot({ path: join(out, "market-first-run-desktop.png"), fullPage: true });

  await check("G7", "the monthly budget is one named field that /settings#monthly-budget scrolls to and focuses", async () => {
    await page.goto(`${base}/settings#monthly-budget`, { waitUntil: "networkidle" });
    const field = page.getByLabel("Monthly budget (USD)");
    await field.waitFor();
    assert.equal(await field.evaluate((node) => node === document.activeElement), true, "the budget field must have focus");
    const text = await page.locator("main").innerText();
    assert.match(text, /not your OpenRouter account balance/);
    assert.doesNotMatch(text, /Monthly video budget/);
  });

  await check("G8", "setup: OpenRouter shows key saved, test passed and active engine as separate steps, and names the engine in use", async () => {
    await page.goto(`${base}/setup`, { waitUntil: "networkidle" });
    const progress = page.getByLabel("OpenRouter setup progress");
    await progress.first().waitFor();
    const text = await progress.first().innerText();
    assert.match(text, /Key saved/);
    assert.match(text, /Connection test passed/);
    assert.match(text, /OpenRouter is the active engine/);
    assert.match(text, /Save your OpenRouter key/);
  });

  await check("G9", "setup: the sources step does not ask for a key to read a page, and says TikTok, Instagram and the rest need none", async () => {
    await page.goto(`${base}/setup`, { waitUntil: "networkidle" });
    // An optional step keeps its body behind "Open this step", so open the one for sources as a person would.
    const step = page.locator("li, section, article").filter({ hasText: "Pick where examples come from" }).filter({ has: page.getByText("Open this step") }).last();
    await step.getByText("Open this step").first().click();
    const text = await page.locator("main").innerText();
    assert.match(text, /Read one public page/);
    assert.match(text, /This is not a search/);
    assert.match(text, /TikTok, Instagram, X, Facebook, Pinterest, LinkedIn and licensed data are not available in this release, and no key is needed/);
    assert.doesNotMatch(text, /DEPLOYMENT_|YOUTUBE_API_KEY=|META_AD_LIBRARY_TOKEN=/);
  });

  await check("D1", "no request left the local server during the run", async () => {
    assert.deepEqual(external, [], `external requests: ${external.slice(0, 3).join(", ")}`);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await holds.waitFor();
  await holds.scrollIntoViewIfNeeded();
  await check("E1", "phone width: no horizontal page scroll", async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the viewport`);
  });
  await holds.screenshot({ path: join(out, "holds-section-phone-390.png") });
} finally {
  await browser.close();
}

const failed = results.filter((item) => item.result === "FAIL");
console.log(`SUMMARY ${results.length - failed.length} pass, ${failed.length} fail`);
process.exitCode = failed.length ? 1 : 0;
