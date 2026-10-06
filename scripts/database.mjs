import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDir = "/workspace/.data/pglite";
mkdirSync(dataDir, { recursive: true });
const db = new PGlite(dataDir);
await db.waitReady;
const server = new PGLiteSocketServer({
  db,
  host: "127.0.0.1",
  port: 54329,
  maxConnections: 40,
});
await server.start();
console.log("[database] postgres://127.0.0.1:54329/postgres");
await new Promise(() => {});
