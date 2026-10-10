import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.PRODUCT_BASE_URL ?? "http://127.0.0.1:8080";
const stamp = Date.now();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const failures = [];
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "artifacts/e2e");
mkdirSync(artifactDir, { recursive: true });
const tracePath = resolve(artifactDir, "product-loop-trace.zip");
const screenshotPath = resolve(artifactDir, "product-loop-failure.png");
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
let exitCode = 0;

function serious(results) {
  return results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
}

async function scan(name) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = serious(results);
  if (violations.length) {
    failures.push({
      name,
      violations: violations.map((item) => ({ id: item.id, help: item.help, nodes: item.nodes.slice(0, 2).map((node) => node.target.join(" ")) })),
    });
  }
}

try {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Your name").fill("Loop Fixture");
  await page.getByLabel("Email").fill(`loop-${stamp}@example.com`);
  await page.getByLabel(/^Password/).fill("fixture-pass-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  await page.getByRole("heading", { name: "Name the workspace" }).waitFor({ timeout: 20000 });
  await page.getByLabel("Workspace name").fill(`Loop ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("heading", { name: "Workspace overview" }).waitFor();
  await page.goto(`${base}/brands/new`, { waitUntil: "networkidle" });
  await page.getByLabel("Brand name").fill("Lather Co");
  await page.getByLabel("What do you sell?").fill("A plain soap bar.");
  await page.getByRole("button", { name: "Create brand" }).click();
  await page.waitForURL((url) => /\/brands\/(?!new$)[^/]+\/?$/.test(url.pathname), { timeout: 20000 });
  const brandUrl = page.url().replace(/\/$/, "");

  await page.goto(`${brandUrl}/products`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add product" }).click();
  const productForm = page.getByRole("dialog").filter({ hasText: "Add product" }).locator("form");
  await productForm.getByLabel("Name").fill("Lather bar");
  await productForm.getByLabel("Description").fill("A plain bar with a visible lather.");
  await productForm.getByRole("button", { name: "Add product" }).click();
  await page.getByRole("heading", { name: "Lather bar" }).waitFor();

  await page.goto(`${brandUrl}/brain`, { waitUntil: "networkidle" });
  await page.getByLabel("Positioning").fill("Cold-process soap. The point is the lather and the proof of a simple bar.");
  await page.getByLabel("Value proposition").fill("Show the lather. Show the proof. Do not invent a cure.");
  await page.getByLabel("Target customers").fill("People who already buy a plain bar of soap.");
  await page.getByLabel("Tone").fill("Plain, specific, and calm.");
  await page.getByLabel("Preferred formats").fill("short ugc");
  await page.getByRole("button", { name: "Save brain" }).click();
  await page.getByText("Version 2").waitFor();

  await page.goto(`${brandUrl}/market`, { waitUntil: "networkidle" });
  await page.getByLabel("Name").fill("North Foam");
  await page.getByRole("button", { name: "Add competitor" }).click();
  await page.getByText("North Foam").first().waitFor();

  async function observe(angle, observed, hook, message) {
    await page.locator("select[name='competitorId']").selectOption({ label: "North Foam" });
    if (angle) await page.locator("select[name='angle']").selectOption(angle);
    else await page.locator("select[name='angle']").selectOption("");
    await page.locator("input[name='observedAngle']").fill(observed);
    await page.locator("input[name='hook']").fill(hook);
    await page.locator("textarea[name='message']").fill(message);
    await page.getByRole("button", { name: "Store observation" }).click();
    await page.getByText("Observation stored.").waitFor();
    await page.getByText(hook).first().waitFor();
  }
  for (let index = 1; index <= 3; index += 1) {
    await observe("offer", "", `Offer hook ${index}`, `Discount and save on price, rival line ${index}.`);
  }
  for (let index = 1; index <= 2; index += 1) {
    await observe("", "lather proof", `Lather hook ${index}`, `A competitor shows lather and proof without a discount, note ${index}.`);
  }

  await page.goto(`${brandUrl}/opportunities`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Rank opportunities" }).click();
  await page.getByText(/candidates? ranked/).waitFor();

  await page.goto(`${brandUrl}/library`, { waitUntil: "networkidle" });
  for (let index = 1; index <= 3; index += 1) {
    await page.locator("select[name='angle']").last().selectOption("offer");
    await page.locator("input[name='hook']").last().fill(`Old offer ${index}`);
    await page.locator("textarea[name='message']").last().fill(`We already ran an offer angle, script ${index}.`);
    await page.getByRole("button", { name: "Save to library" }).click();
    await page.getByRole("heading", { name: `Old offer ${index}` }).waitFor();
  }
  for (let index = 1; index <= 3; index += 1) {
    const card = page.locator("li").filter({ hasText: `Old offer ${index}` });
    await card.getByRole("button", { name: "Trace" }).click();
    await page.getByLabel("Date").fill("2026-02-01");
    await page.getByLabel("Impressions").fill("400");
    await page.getByLabel("Clicks").fill("8");
    await page.getByLabel("Conversions").fill("0");
    await page.getByLabel("Spend (cents)").fill("100");
    await page.getByLabel("Revenue (cents)").fill("0");
    await page.getByRole("button", { name: "Record performance" }).click();
    await page.getByText("Performance stored").waitFor();
  }

  await page.goto(`${brandUrl}/studio`, { waitUntil: "networkidle" });
  await page.getByText("Discovered").first().waitFor({ timeout: 60000 });
  const discovered = await page.locator("body").innerText();
  if (!discovered.toLowerCase().includes("lather")) throw new Error(`Studio did not show the lather evidence. ${discovered.slice(0, 500)}`);
  await page.locator("dd").filter({ hasText: /AUTO_APPROVE|HUMAN_REVIEW|REJECT/ }).first().waitFor();
  // Accepting a direction needs a reason of at least 20 characters. It is recorded with the decision.
  await page.getByLabel(/Why accept this direction/).fill("E2E testing run: the stored lather evidence supports this direction.");
  await page.getByRole("button", { name: "Accept direction and write the brief" }).click();
  await page.getByRole("tab", { name: "2. Brief" }).click();
  await page.getByRole("heading", { name: "Brief" }).waitFor();
  const firstConstraints = await page.getByTestId("brief-constraints").innerText();
  // The decision engine is not configured in the testing runtime, so the brief the engine could not judge is held. Generation
  // must stay blocked until an explicit review is recorded, and that review is what this step performs.
  const held = page.getByRole("heading", { name: /Held for review:/ });
  await held.waitFor({ timeout: 60000 });
  // The disclosure loads after the panel heading, so wait for its content rather than checking once.
  await page.getByText("Questions the engine did not answer").waitFor({ timeout: 60000 });
  await page.getByRole("tab", { name: "3. Generate" }).click();
  if (!(await page.getByRole("button", { name: "Generate variants" }).isDisabled())) throw new Error("Generation was not blocked for a brief awaiting review.");
  await page.getByRole("tab", { name: "2. Brief" }).click();
  await page.getByRole("checkbox", { name: /I have read the failure/ }).check();
  await page.getByLabel(/Reason \(at least 20 characters\)/).fill("E2E testing runtime: the decision engine is not configured, so the brief is reviewed explicitly here.");
  await page.getByRole("button", { name: "Approve for production" }).click();
  await held.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "3. Generate" }).click();
  await page.locator("select[name='imageProvider']").selectOption("test:image");
  await page.locator("select[name='videoProvider']").selectOption("none");
  await page.getByRole("button", { name: "Generate variants" }).click();
  const planReview = page.getByRole("dialog", { name: "Review Creative Plan" });
  await planReview.waitFor({ state: "visible" });
  await planReview.getByRole("button", { name: "Approve & Generate" }).click();
  await planReview.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "4. Review" }).click();
  await page.getByRole("img", { name: /test:image image variant/ }).first().waitFor({ timeout: 60000 });
  const previewCount = await page.getByRole("img", { name: /test:image image variant/ }).count();
  if (previewCount < 3) throw new Error(`Expected 3 image previews, saw ${previewCount}.`);

  const approve = page.getByRole("button", { name: "Approve" });
  const approveCount = await approve.count();
  if (approveCount < 3) throw new Error(`Expected review buttons, saw ${approveCount}.`);
  await approve.first().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Publish with test publisher" }).first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Inspect evidence" }).first().click();
  await page.getByText("logo_match").first().waitFor();
  await page.getByText(/answer (yes|no|uncertain|insufficient|violation)/).first().waitFor();
  await page.getByRole("button", { name: "Reject" }).first().click();
  await page.getByLabel("Reviewer note").fill("Reject this test fixture variant.");
  await page.getByRole("button", { name: "Confirm rejection" }).click();
  await page.getByRole("button", { name: "Request revision" }).first().click();
  await page.getByLabel("Reviewer note").fill("Request a clearer product demonstration.");
  await page.getByRole("button", { name: "Send revision request" }).click();
  await page.getByLabel("Compare").selectOption({ index: 1 });
  await page.getByLabel("With").selectOption({ index: 2 });
  await page.getByRole("button", { name: "Publish with test publisher" }).first().click();
  await page.getByText(/Test publication test:/).first().waitFor();
  await page.getByRole("button", { name: "Publish with test publisher" }).nth(0).click().catch(() => {});
  const publishButtons = page.getByRole("button", { name: "Publish with test publisher" });
  const publishCount = await publishButtons.count();
  for (let index = 0; index < Math.min(publishCount, 2); index += 1) {
    await publishButtons.nth(0).click();
    await page.waitForTimeout(200);
  }
  await page.getByRole("button", { name: "Record test-provider performance and learn" }).click();
  await page.getByText(/angle=offer:/).first().waitFor({ timeout: 30000 });
  await page.getByRole("tab", { name: "2. Brief" }).click();
  // Writing the next brief accepts a direction too, so it needs the same reason as the accept step.
  await page.getByLabel(/Why accept this direction/).fill("E2E testing run: the learned offer angle is the next direction.");
  await page.getByRole("button", { name: "Write the next brief" }).click();
  await page.waitForFunction((previous) => {
    const node = document.querySelector("[data-testid='brief-constraints']");
    const text = node?.textContent ?? "";
    return text.trim() !== String(previous).trim() && text.toLowerCase().includes("offer");
  }, firstConstraints);
  const secondConstraints = await page.getByTestId("brief-constraints").innerText();
  if (secondConstraints === firstConstraints) throw new Error("The next brief did not change.");
  if (!secondConstraints.toLowerCase().includes("offer")) throw new Error(`Next brief did not learn the offer constraint. ${secondConstraints.slice(0, 400)}`);
  await page.getByText("These findings changed the next recommendation.").waitFor();

  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Scoring weights" }).click();
  const weightForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save diagnostic weights" }) });
  const entries = await weightForm.locator("input").evaluateAll((nodes) => nodes.map((node) => ({ name: node.name, value: node.value, message: node.validationMessage })));
  const bad = entries.filter((entry) => entry.message);
  if (bad.length) throw new Error(`Weight widgets failed validation: ${JSON.stringify(bad)}`);
  await page.getByRole("button", { name: "Save diagnostic weights" }).click();
  await page.getByText("Diagnostic weights saved.").waitFor();

  for (const path of ["/studio", "/opportunities", "/library", "/learning"]) {
    await page.goto(`${brandUrl}${path}`, { waitUntil: "networkidle" });
    await scan(path);
  }
  await page.goto(`${base}/integrations`, { waitUntil: "networkidle" });
  await scan("/integrations");

  console.log(JSON.stringify({ ok: true, failures, firstConstraints: firstConstraints.slice(0, 180), secondConstraints: secondConstraints.slice(0, 240) }, null, 2));
  if (failures.length) exitCode = 1;
} catch (error) {
  const text = await page.locator("body").innerText().catch(() => "");
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), url: page.url(), text: text.slice(0, 1500), failures }, null, 2));
  exitCode = 1;
} finally {
  if (exitCode) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    console.error(JSON.stringify({ e2eArtifacts: { screenshot: screenshotPath, trace: tracePath } }));
  } else {
    await context.tracing.stop().catch(() => {});
  }
  await browser.close();
}
process.exitCode = exitCode;
