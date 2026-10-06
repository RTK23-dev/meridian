import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
