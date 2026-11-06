// A file that ships beside a module (a component's HTML, the vendored motion kit, a recorded fixture), read on first use.
//
// Run from source (the tests, the worker, the scheduler), the file sits beside the module. In the web app's production bundle the
// module is inlined into a chunk somewhere else, and the file is not copied with it; there the read falls back to the file's path in
// the repository, under the working directory (the Docker image keeps the repository at /app and starts the server there).
//
// The read happens on first use, never when the module loads. A module that is only imported, for example a settings page that imports
// the engine for one helper, never touches the disk. Reading at load time took down every server function of eleven app modules on the
// live site; source-file.test.ts refuses a module-level file read anywhere in src.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A lazy reader of one file that ships with the code. `relative` is the path from the module (for example "./component.html");
 * `repoPath` is the same file's path from the repository root, used when the module runs from a bundle. The file is read once.
 */
export function sourceFile(moduleUrl: string, relative: string, repoPath: string): () => string {
  if (isAbsolute(repoPath) || repoPath.startsWith("..")) throw new Error(`sourceFile: "${repoPath}" must be relative to the repository root`);
  let text: string | null = null;
  return () => {
    if (text !== null) return text;
    const besideModule = fileURLToPath(new URL(relative, moduleUrl));
    const inRepository = join(process.cwd(), repoPath);
    for (const path of [besideModule, inRepository]) {
      try {
        text = readFileSync(path, "utf8");
        return text;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`the file ${repoPath} that ships with the code was not found beside its module or under ${process.cwd()}`);
  };
}
