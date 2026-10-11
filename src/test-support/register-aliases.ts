import { register } from "node:module";

/** Lets a test import a module that uses the "@/" alias. Call it before the first dynamic import of that module. */
export async function registerAliases(): Promise<void> {
  register("./alias-hooks.mjs", import.meta.url);
}
