/**
 * Lets a test load server modules that use the "@/" alias, by registering alias-hooks.mjs once for this test process. A test
 * calls this before it imports such a module, with a dynamic import, so the hook is in place when the module loads.
 */
import { register } from "node:module";

let registered = false;

export function enableAppAliases(): void {
  if (registered) return;
  register("./alias-hooks.mjs", import.meta.url);
  registered = true;
}
