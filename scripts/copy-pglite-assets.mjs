import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const destDir = ".vercel/output/functions/__server.func/_libs";
const srcDir = "node_modules/@electric-sql/pglite/dist";
const files = ["pglite.data", "pglite.wasm", "initdb.wasm"];

if (!existsSync(destDir)) {
  console.log("[pglite] server bundle not found, skipping asset copy");
  process.exit(0);
}

for (const name of files) {
  copyFileSync(join(srcDir, name), join(destDir, name));
}
console.log("[pglite] copied wasm assets next to the server bundle");
