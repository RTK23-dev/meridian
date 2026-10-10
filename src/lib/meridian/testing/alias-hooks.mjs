/**
 * Test-only module resolution, registered by enableAppAliases() in module-aliases.ts. The app's bundler resolves the "@/"
 * alias and extensionless relative imports; the Node test runner does not. Without this hook a test could not load the
 * server modules that use the alias. It changes nothing in production: it runs only in test processes that register it.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** @param {string} candidate @returns {boolean} */
function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: object) => Promise<any>} nextResolve
 * @returns {Promise<any>}
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.join(SRC, specifier.slice(2));
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  // A relative import without the ".ts" suffix. The suffix test is by file, not by extension, because names such as
  // "./brief-service.server" have an extension of their own.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (!isFile(base) && isFile(`${base}.ts`)) return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
