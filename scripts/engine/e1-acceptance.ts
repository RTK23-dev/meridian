// The E1 acceptance (Bible section 19, E1): one hand-written EDL with one stock clip, one TTS voice file and three components
// is reserved, compiled, rendered through HeyGen's HyperFrames cloud, checked by the render-integrity probe, and reconciled in
// the ledger. It prints a JSON report on stdout. Progress and refusals go to stderr.
//
//   node --experimental-strip-types scripts/engine/e1-acceptance.ts --dry-run
//   node --experimental-strip-types scripts/engine/e1-acceptance.ts --org <id> --brand <id> --media-functions-url <url> \
//        --platform-max-bytes <n>  [--count N] [--budget-usd X] [--month-budget-usd Y] [--stock-uri U] [--voice-uri V]
//
// Exit codes: 0 the run passed; 1 the run failed a check (the report says which); 2 bad usage; 3 NOT_CONNECTED, which means
// a provider, the database or storage is not connected and nothing was spent.
//
// The dry run replays recorded responses through the gateway's injected transport: no network, no key. It proves the wiring,
// not the provider. The live run is the owner's (scripts/engine/README.md).

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { usdSchema } from "../../src/engine/contracts/index.ts";
import { createGateway, type CredentialSource, type Gateway } from "../../src/engine/gateway/index.ts";
import { DEFAULT_POLL_INTERVAL_MS } from "../../src/engine/render/hyperframesCloud.ts";
import { E1_STOCK_URI, E1_VOICE_URI } from "./e1-build.ts";
import { memoryBackend, memoryMediaStore, sqlBackend, type E1Backend } from "./e1-backend.ts";
import { liveSetup, type Missing } from "./e1-live.ts";
import { createReplay, DRY_RUN_KEY, loadRecording } from "./e1-replay.ts";
import { E1_REPORT_SCHEMA, runE1, type E1Report, type RunOptions } from "./e1-run.ts";

const DRY_RUN_ORG = "ws_e1_dry_run";
const DRY_RUN_BRAND = "brand_e1_dry_run";
const DEFAULT_REQUEST_BUDGET_USD = 1;
const DEFAULT_MONTH_BUDGET_USD = 50;
const MAX_COUNT = 50;

export const EXIT = { pass: 0, fail: 1, usage: 2, notConnected: 3 } as const;

const USAGE = `usage: e1-acceptance.ts (--dry-run | --org <id>) [options]

  --dry-run                 replay the recorded responses; no network, no keys (--org and --brand are optional)
  --org <id>                the workspace of a live run (required for a live run)
  --brand <id>              the brand the media is filed under (required for a live run)
  --count <n>               masters to render, 1 to ${MAX_COUNT} (default 1)
  --budget-usd <x>          request budget per master (default ${DEFAULT_REQUEST_BUDGET_USD})
  --month-budget-usd <y>    workspace monthly budget (default ${DEFAULT_MONTH_BUDGET_USD})
  --media-functions-url <u> the deployed ffmpeg media functions (a live run)
  --platform-max-bytes <n>  the platform's file-size limit for the integrity check (a live run)
  --stock-uri <uri>         the stock clip, a store:// URI (default ${E1_STOCK_URI})
  --voice-uri <uri>         the TTS voice file, a store:// URI (default ${E1_VOICE_URI})
  --database                a live run: keep the ledger and artifacts in the Postgres that DATABASE_URL names (required)
  --with-database           a dry run: keep the ledger and artifacts in the test helper's PGlite database
`;

export class UsageError extends Error {}

export type Options = {
  dryRun: boolean;
  withDatabase: boolean;
  database: boolean;
  organizationId: string | null;
  brandId: string | null;
  count: number;
  requestBudgetUsd: number;
  workspaceMonthBudgetUsd: number;
  mediaFunctionsUrl: string | null;
  platformMaxBytes: number | null;
  stockUri: string;
  voiceUri: string;
};

function parseUsd(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = usdSchema.safeParse(Number(value));
  if (!/^\d+(\.\d{1,4})?$/.test(value) || !parsed.success) {
    throw new UsageError(`${name} must be a USD amount with at most four decimals, got "${value}"`);
  }
  return parsed.data;
}

function parseMediaUri(value: string | undefined, fallback: string, name: string): string {
  const uri = value ?? fallback;
  if (!uri.startsWith("store://") || uri.length <= "store://".length) {
    throw new UsageError(`${name} must be a store:// URI, got "${uri}"`);
  }
  return uri;
}

/** Reads the command line. Only argv is read here; the environment is never read (keys come from the gateway). */
export function parseOptions(argv: string[]): Options {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "dry-run": { type: "boolean" },
        "with-database": { type: "boolean" },
        database: { type: "boolean" },
        org: { type: "string" },
        brand: { type: "string" },
        count: { type: "string" },
        "budget-usd": { type: "string" },
        "month-budget-usd": { type: "string" },
        "media-functions-url": { type: "string" },
        "platform-max-bytes": { type: "string" },
        "stock-uri": { type: "string" },
        "voice-uri": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const dryRun = values["dry-run"] === true;
  const organizationId = typeof values.org === "string" ? values.org : null;
  if (!dryRun && organizationId === null) {
    throw new UsageError("pass --dry-run, or --org <id> for a live run");
  }
  const withDatabase = values["with-database"] === true;
  if (!dryRun && withDatabase) {
    throw new UsageError("--with-database is for dry runs; a live run uses --database");
  }
  const database = values.database === true;
  if (dryRun && database) {
    throw new UsageError("--database is for a live run; a dry run keeps its ledger in memory, or in the test helper with --with-database");
  }
  const brandId = typeof values.brand === "string" ? values.brand : null;
  if (!dryRun && brandId === null) throw new UsageError("a live run needs --brand <id>");

  const countText = typeof values.count === "string" ? values.count : "1";
  if (!/^\d+$/.test(countText) || Number(countText) < 1 || Number(countText) > MAX_COUNT) {
    throw new UsageError(`--count must be a whole number from 1 to ${MAX_COUNT}, got "${countText}"`);
  }

  let mediaFunctionsUrl: string | null = null;
  if (typeof values["media-functions-url"] === "string") {
    try {
      const url = new URL(values["media-functions-url"]);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
      mediaFunctionsUrl = url.toString().replace(/\/+$/, "");
    } catch {
      throw new UsageError("--media-functions-url must be an http or https URL");
    }
  }

  let platformMaxBytes: number | null = null;
  if (typeof values["platform-max-bytes"] === "string") {
    if (!/^\d+$/.test(values["platform-max-bytes"]) || Number(values["platform-max-bytes"]) <= 0) {
      throw new UsageError("--platform-max-bytes must be a positive whole number of bytes");
    }
    platformMaxBytes = Number(values["platform-max-bytes"]);
  }

  return {
    dryRun,
    withDatabase,
    database,
    organizationId,
    brandId,
    count: Number(countText),
    requestBudgetUsd: parseUsd(typeof values["budget-usd"] === "string" ? values["budget-usd"] : undefined, DEFAULT_REQUEST_BUDGET_USD, "--budget-usd"),
    workspaceMonthBudgetUsd: parseUsd(
      typeof values["month-budget-usd"] === "string" ? values["month-budget-usd"] : undefined,
      DEFAULT_MONTH_BUDGET_USD,
      "--month-budget-usd",
    ),
    mediaFunctionsUrl,
    platformMaxBytes,
    stockUri: parseMediaUri(typeof values["stock-uri"] === "string" ? values["stock-uri"] : undefined, E1_STOCK_URI, "--stock-uri"),
    voiceUri: parseMediaUri(typeof values["voice-uri"] === "string" ? values["voice-uri"] : undefined, E1_VOICE_URI, "--voice-uri"),
  };
}

/** The dry run's credential: a placeholder that is not a key. The replay refuses it anywhere but the HeyGen requests. */
const dryRunCredentials: CredentialSource = {
  async get(credentialId) {
    if (credentialId === "heygen") return { status: "ready", credential: { kind: "api_key", secret: DRY_RUN_KEY } };
    return { status: "not_connected", reason: `dry run: ${credentialId} is not part of the recorded replay` };
  },
};

type Output = { stdout: (text: string) => void; stderr: (text: string) => void };

function printJson(output: Output, value: unknown): void {
  output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function sleepReal(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function summary(output: Output, report: E1Report): void {
  const verdict = report.pass ? "PASS" : "FAIL";
  output.stderr(
    `E1 acceptance (${report.mode}, backend ${report.backend}): ${verdict}, ${report.totals.passed} of ${report.totals.masters} masters passed.\n`,
  );
}

function notConnected(output: Output, organizationId: string, missing: Missing[]): number {
  for (const item of missing) output.stderr(`NOT_CONNECTED ${item.item}: ${item.reason}\n`);
  output.stderr("NOT_CONNECTED: no request was sent and no budget was reserved.\n");
  printJson(output, {
    schema: E1_REPORT_SCHEMA,
    status: "NOT_CONNECTED",
    mode: "live",
    organizationId,
    missing,
    spend: "none",
  });
  return EXIT.notConnected;
}

/** The dry run's gateway and backend. Every request goes to the replay; nothing is sent to the network. */
async function dryRunWiring(options: Options): Promise<{ gateway: Gateway; backend: E1Backend; finish: () => void; close: () => Promise<void> }> {
  const recording = loadRecording();
  const steps = Array.from({ length: options.count }, () => recording.render).flat();
  const replay = createReplay(steps);
  const gateway = createGateway({
    transport: replay.transport,
    credentials: dryRunCredentials,
    providers: { media_functions: { baseUrl: recording.mediaFunctionsBaseUrl } },
  });
  const media = memoryMediaStore(recording.assets);
  const organizationId = options.organizationId ?? DRY_RUN_ORG;
  const brandId = options.brandId ?? DRY_RUN_BRAND;
  if (!options.withDatabase) {
    return { gateway, backend: memoryBackend(media), finish: () => replay.finish(), close: async () => {} };
  }
  // The test helper's database (PGlite, or the server MERIDIAN_PG_TEST_URL names). It is not DATABASE_URL, and it is dropped.
  const { createTestDatabase, seedWorkspace } = await import("../../src/engine/test/pg-test-db.ts");
  const db = await createTestDatabase();
  try {
    await seedWorkspace(db.sql, organizationId, brandId);
    const backend = await sqlBackend({ sql: db.sql, label: `postgres (${db.engine}, test helper)`, media, organizationId });
    return { gateway, backend, finish: () => replay.finish(), close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** Runs the acceptance and returns the exit code. The report is printed in both the pass and the fail case. */
export async function main(argv: string[], output: Output = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.stdout(USAGE);
    return EXIT.pass;
  }
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      output.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }

  if (options.dryRun) {
    const recording = loadRecording();
    let wiring: Awaited<ReturnType<typeof dryRunWiring>> | null = null;
    try {
      wiring = await dryRunWiring(options);
      const report = await runE1(
        {
          mode: "dry-run",
          organizationId: options.organizationId ?? DRY_RUN_ORG,
          brandId: options.brandId ?? DRY_RUN_BRAND,
          count: options.count,
          requestBudgetUsd: options.requestBudgetUsd,
          workspaceMonthBudgetUsd: options.workspaceMonthBudgetUsd,
          platformMaxBytes: recording.dryRunPlatformMaxBytes,
          platformMaxBytesSource: "dry-run fixture: the platform's limit is not set in config (thresholds.render.platformMaxBytes)",
          stockUri: options.stockUri,
          voiceUri: options.voiceUri,
          pollIntervalMs: 0,
          sleep: async () => {},
          provenance: recording.provenance,
        },
        { gateway: wiring.gateway, backend: wiring.backend },
      );
      try {
        wiring.finish();
      } catch (error) {
        report.pass = false;
        report.notes.push(error instanceof Error ? error.message : String(error));
      }
      printJson(output, report);
      summary(output, report);
      return report.pass ? EXIT.pass : EXIT.fail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(`E1 acceptance (dry run) stopped: ${message}\n`);
      printJson(output, { schema: E1_REPORT_SCHEMA, status: "FAILED", mode: "dry-run", message });
      return EXIT.fail;
    } finally {
      await wiring?.close();
    }
  }

  const organizationId = options.organizationId as string;
  const brandId = options.brandId as string;
  const setup = await liveSetup({
    organizationId,
    brandId,
    mediaFunctionsBaseUrl: options.mediaFunctionsUrl,
    platformMaxBytes: options.platformMaxBytes,
    database: options.database,
  });
  if (!setup.ok) return notConnected(output, organizationId, setup.missing);

  const runOptions: RunOptions = {
    mode: "live",
    organizationId,
    brandId,
    count: options.count,
    requestBudgetUsd: options.requestBudgetUsd,
    workspaceMonthBudgetUsd: options.workspaceMonthBudgetUsd,
    platformMaxBytes: options.platformMaxBytes as number,
    platformMaxBytesSource: "--platform-max-bytes",
    stockUri: options.stockUri,
    voiceUri: options.voiceUri,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    sleep: sleepReal,
    provenance: "live: the provider's own responses, recorded by this run's report and the owner's invoices",
  };
  try {
    const report = await runE1(runOptions, { gateway: setup.gateway, backend: setup.backend });
    printJson(output, report);
    summary(output, report);
    return report.pass ? EXIT.pass : EXIT.fail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.stderr(`E1 acceptance (live) stopped: ${message}\n`);
    printJson(output, { schema: E1_REPORT_SCHEMA, status: "FAILED", mode: "live", message });
    return EXIT.fail;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`E1 acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.fail;
    },
  );
}
