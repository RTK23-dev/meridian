import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { createLocalJobRunner, localJobsEnabled } from "./scripts/local-jobs.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Directories the dev server may serve files from. Vite's default is the
 * workspace root only, so this keeps that and adds the real `node_modules`.
 *
 * `node_modules` can be a symlink to a directory outside the project (git
 * worktrees and shared installs do this). Vite resolves packages such as
 * `@fontsource-variable/inter` to that real path and rewrites their `url()`
 * assets to `/@fs/<real path>`. Anything outside `server.fs.allow` gets a 403,
 * so the fonts never load. In a normal install the real path is already under
 * the root, so the extra entry changes nothing.
 */
function devServeAllowList(root: string): string[] {
  const allow = [searchForWorkspaceRoot(root)];
  try {
    allow.push(realpathSync(join(root, "node_modules")));
  } catch {
    // No node_modules yet (before `npm ci`): nothing extra to allow.
  }
  return allow;
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Local trial only, dev server only: with DATABASE_URL unset, the embedded database is opened by this process, so
 * `npm run worker` cannot reach it (PGlite is single-writer). This runs the same pass the worker runs (`tickSqlJobs`) against
 * the web app's own database instance, through the dev server's module loader. A failed pass is logged and retried with a
 * back-off, and never stops the dev server. The loop stops when the server closes.
 */
function localJobsPlugin(): Plugin {
  return {
    name: "app-builder:local-jobs",
    apply: "serve",
    configureServer(server) {
      if (!localJobsEnabled(process.env)) return;
      // Without migrations there is no jobs table, so there is nothing to run.
      if (!hasGlobbedMigrations(server.config.root)) return;
      const runner = createLocalJobRunner({
        runTick: async () => {
          const db = (await server.ssrLoadModule("/src/lib/db.ts")) as {
            getSql: () => Promise<unknown>;
          };
          // Loaded on every pass, so an edit to the job code takes effect on the next pass.
          const worker = (await server.ssrLoadModule("/src/lib/meridian/jobs/sql-worker.ts")) as {
            tickSqlJobs: (sql: unknown) => Promise<{ claimed: number; stopped: boolean }>;
          };
          return worker.tickSqlJobs(await db.getSql());
        },
      });
      server.httpServer?.once("close", () => runner.stop());
      runner.start();
    },
  };
}

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    fs: {
      allow: devServeAllowList(process.cwd()),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  // Pre-bundled at startup. A client module discovered after the first load makes Vite re-optimize and reload the page. A
  // reload mid-load can leave the sign-in form without its script, and then a submit falls back to a native page refresh.
  optimizeDeps: {
    include: [
      "better-auth/react",
      "react-hook-form",
      "@hookform/resolvers/zod",
      "zod",
      // Nested packages that better-auth/react loads at run time. Vite found them only after the first load, and each late
      // find re-optimized the dependencies and reloaded the page mid-flow, so pending saves were lost.
      "@better-auth/core",
      "@better-auth/core/api",
      "@better-auth/core/context",
      "@better-auth/core/db",
      "@better-auth/core/db/adapter",
      "@better-auth/core/env",
      "@better-auth/core/error",
      "@better-auth/core/instrumentation",
      "@better-auth/core/oauth2",
      "@better-auth/core/social-providers",
      "@better-auth/core/utils/db",
      "@better-auth/core/utils/id",
      "@better-auth/core/utils/ip",
      "@better-auth/core/utils/is-api-error",
      "@better-auth/core/utils/json",
      "@better-auth/core/utils/deprecate",
      "@better-auth/core/utils/error-codes",
      "@better-auth/core/utils/host",
      "@better-auth/core/utils/string",
      "@better-auth/core/utils/url",
      "@better-fetch/fetch",
      "defu",
      "nanostores",
      // Found by a cold start (a fresh node_modules/.vite): the sign-in and data layers load these only after the first page
      // load, so Vite re-optimized and reloaded the page with a save in flight. They are bundled at startup now.
      "@better-auth/kysely-adapter",
      "@better-auth/telemetry",
      "@better-auth/utils",
      "@better-auth/utils/base64",
      "@better-auth/utils/binary",
      "@better-auth/utils/hash",
      "@better-auth/utils/hmac",
      "@better-auth/utils/password",
      "@better-auth/utils/random",
      "@noble/ciphers/chacha.js",
      "@noble/ciphers/utils.js",
      "@noble/hashes/hkdf.js",
      "@noble/hashes/sha2.js",
      "@tanstack/history",
      "@tanstack/router-core",
      "@tanstack/router-core/isServer",
      "@tanstack/router-core/ssr/client",
      "@tanstack/router-core/ssr/server",
      "better-call",
      "h3-v2",
      "jose",
      "jose/errors",
      "seroval",
    ],
  },
  plugins: [
    pgliteBootstrapPlugin(),
    localJobsPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({ preset: "vercel" }),
        ]
      : []),
    viteReact(),
  ],
}));
