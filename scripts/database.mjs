import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.PGLITE_DATA?.trim() || join(root, ".data", "pglite");
const port = Number(process.env.PGLITE_PORT ?? 54329);
mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);
await db.waitReady;
const server = new PGLiteSocketServer({
  db,
  host: "127.0.0.1",
  port,
  maxConnections: 40,
});
await server.start();
console.log(`[database] postgres://127.0.0.1:${port}/postgres`);
await new Promise(() => {});
