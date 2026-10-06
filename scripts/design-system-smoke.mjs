#!/usr/bin/env node
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";

const url = checkedUrl(process.argv[2] || "http://127.0.0.1:8080/_design");
const outputRoot = resolve(process.env.DESIGN_SMOKE_OUTPUT_ROOT || process.cwd());
const outputDir = checkedOutputPath(process.env.DESIGN_SMOKE_DIR || "artifacts/design-system", [outputRoot], "design system screenshots");
const widths = [390, 768, 1440];
const themes = ["light", "dark"];
mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of themes) {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForFunction((expected) => document.documentElement.classList.contains("dark") === expected, theme === "dark");
      if (!(await page.getByRole("heading", { name: "Design system", exact: true }).count())) {
        throw new Error("The development-only design system route did not render.");
      }
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const serious = violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
      if (serious.length) {
        throw new Error(`Design system has ${serious.length} serious accessibility violations at ${width}px (${theme}):\n${serious.map((item) => `${item.id}: ${item.help}\n${item.nodes.map((node) => `  ${node.target.join(" ")}: ${node.failureSummary}`).join("\n")}`).join("\n")}`);
      }
      await page.screenshot({ path: join(outputDir, `${width}-${theme}.png`), fullPage: true });
      console.log(`Design system accessibility: ${width}px ${theme} passed (${violations.length} non-serious violations).`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
