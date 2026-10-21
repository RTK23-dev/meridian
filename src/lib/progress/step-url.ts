/** A step name is one lowercase word, such as brief or plan. */
const STEP_SEGMENT = /^[a-z][a-z0-9-]*$/;

function withoutTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The URL of one step under a base path, such as /create/brief or /create/<planId>/plan. */
export function stepPath(base: string, step: string): string {
  return `${withoutTrailingSlash(base)}/${step}`;
}

/**
 * The step a path names under the base, or null. The query string and the hash are ignored, and one trailing slash is
 * allowed. Only one segment counts as a step, and the caller still checks the step against its own order.
 */
export function parseStepFromPath(path: string, base: string): string | null {
  const [pathname = ""] = path.split(/[?#]/, 1);
  const prefix = `${withoutTrailingSlash(base)}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length).replace(/\/$/, "");
  return STEP_SEGMENT.test(segment) ? segment : null;
}
