// Renders the price data Meridian holds into plain files, so the prices can be read offline and fed to research. The functions are
// pure: the caller passes the data in, and scripts/export-prices.ts writes the files. export.test.ts fails when the committed files
// drift from the data. A price that is not known is written as "unknown", never as 0.

import { prices, type Price } from "../../../engine/config/prices.ts";
import { TOKEN_PRICES, type TokenPriceEntry } from "../factory/price-table.ts";

export type CatalogEntry = {
  id: string;
  name: string;
  kind: string;
  pricing: {
    promptUsdPerToken: number | null;
    completionUsdPerToken: number | null;
    imageUsd: number | null;
    usdPerSecond1080p: number | null;
  };
};

export type CatalogSnapshot = { source: string; takenAt: string; entries: CatalogEntry[] };

export type PriceFiles = Record<string, string>;

/** A number as text, rounded to twelve significant figures, so 0.00001 * 1e6 reads as 10. */
function num(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/** A known number, or the word "unknown" for a price nobody has recorded. */
function cell(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : num(value);
}

/** One CSV line. A cell with a comma, a quote or a line break is quoted, and its quotes doubled. */
export function csvLine(cells: readonly string[]): string {
  return cells
    .map((value) => (/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
    .join(",");
}

function csvFile(rows: readonly (readonly string[])[]): string {
  return `${rows.map(csvLine).join("\n")}\n`;
}

/** The engine's own price table: one row per priced key, with its unit, its list price and where the price came from. */
export function engineRows(table: typeof prices.entries): string[][] {
  const header = ["key", "unit", "usd", "source"];
  const body = Object.entries(table).map(([key, price]: [string, Price]) => [key, price.unit, cell(price.usd), price.source]);
  return [header, ...body];
}

/** The Claude token rates, in US dollars per million tokens. */
export function tokenRateRows(): string[][] {
  const header = ["model", "input_usd_per_million_tokens", "output_usd_per_million_tokens"];
  const body = Object.entries(prices.tokenRates).map(([model, rate]) => [model, cell(rate.inputUsdPerMillion), cell(rate.outputUsdPerMillion)]);
  return [header, ...body];
}

/** The Factory's published token prices: a short-context and a long-context row for each model, in US dollars per million tokens. */
export function factoryTokenRows(entries: readonly TokenPriceEntry[]): string[][] {
  const header = ["engine", "model", "tier", "input", "cached_input", "output", "source_url", "read_on"];
  const body = entries.flatMap((entry) => [
    [entry.engineId, entry.model, "short_context", cell(entry.short.input), cell(entry.short.cachedInput), cell(entry.short.output), entry.sourceUrl, entry.readOn],
    [entry.engineId, entry.model, "long_context", cell(entry.long.input), cell(entry.long.cachedInput), cell(entry.long.output), entry.sourceUrl, entry.readOn],
  ]);
  return [header, ...body];
}

/** The OpenRouter listing snapshot: every model's listed price. Prompt and completion prices are per million tokens. */
export function catalogRows(snapshot: CatalogSnapshot): string[][] {
  const header = [
    "id",
    "name",
    "kind",
    "prompt_usd_per_million_tokens",
    "completion_usd_per_million_tokens",
    "image_usd",
    "usd_per_second_1080p",
  ];
  const perMillion = (value: number | null) => (value === null ? null : value * 1_000_000);
  const body = snapshot.entries.map((entry) => [
    entry.id,
    entry.name,
    entry.kind,
    cell(perMillion(entry.pricing.promptUsdPerToken)),
    cell(perMillion(entry.pricing.completionUsdPerToken)),
    cell(entry.pricing.imageUsd),
    cell(entry.pricing.usdPerSecond1080p),
  ]);
  return [header, ...body];
}

/** The readme for the folder: what each file is, where its numbers came from, and what is not known. */
export function readme(snapshot: CatalogSnapshot): string {
  const engineUnknown = Object.entries(prices.entries)
    .filter(([, price]) => price.usd === null)
    .map(([key]) => `\`${key}\``);
  const catalogCount = snapshot.entries.length;
  return `# Meridian prices, as data

These files hold every price Meridian has, so they can be read without running the app, and so research can use them. They are
generated from the code and the snapshot; do not edit them by hand. Regenerate with \`npm run prices:export\`. A test fails if they drift.

A price that is not known is written as \`unknown\`. It is never written as 0.

## The files

- \`engine-prices.csv\` and \`engine-prices.json\`: the video engine's price table. Each row has a key, its unit, its price in US dollars
  and the source of the price. Sources: \`list_oct_2026\` (a list price checked for this table), \`openrouter_listing\` (read from
  OpenRouter's public listing) and \`third_party_unverified\` (not checked against the vendor's own page).
- \`token-rates.csv\`: the Claude token rates, in US dollars per million tokens.
- \`factory-token-prices.csv\`: the Factory's published token prices for the decision model, with the page each was read from and the date.
- \`openrouter-listing-${snapshot.takenAt}.csv\`: every model in the OpenRouter listing snapshot taken on ${snapshot.takenAt}
  (${catalogCount} entries). Prompt and completion prices are per million tokens. Image and per-second video prices are in US dollars.

## What is not known

The engine price table has ${engineUnknown.length} keys with no price: ${engineUnknown.join(", ")}. The HyperFrames cloud render price
(\`render_hyperframes_cloud\`) is one of them. Our data does not contain it, so it is not guessed here.
`;
}

/** Every file of the folder, keyed by its name in docs/data/prices/. */
export function renderPriceFiles(input: {
  catalog: CatalogSnapshot;
  factoryEntries?: readonly TokenPriceEntry[];
}): PriceFiles {
  const catalog = input.catalog;
  return {
    "README.md": readme(catalog),
    "engine-prices.csv": csvFile(engineRows(prices.entries)),
    "engine-prices.json": `${JSON.stringify({ version: prices.version, entries: prices.entries }, null, 2)}\n`,
    "token-rates.csv": csvFile(tokenRateRows()),
    "factory-token-prices.csv": csvFile(factoryTokenRows(input.factoryEntries ?? TOKEN_PRICES)),
    [`openrouter-listing-${catalog.takenAt}.csv`]: csvFile(catalogRows(catalog)),
  };
}
