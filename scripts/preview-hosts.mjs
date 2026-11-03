/**
 * The host names the production preview server (`npm run preview`, which the Dockerfile runs) accepts in the Host header.
 *
 * Vite answers any other host name with 403 "Blocked request", before the app runs. The public origins of this deployment are allowed:
 * APP_URL, PUBLIC_APP_URL and BETTER_AUTH_URL, read from the environment when the server starts. localhost and IP addresses are always
 * allowed by Vite, so the container healthcheck needs nothing here.
 *
 * Only an https origin with a plain host name contributes. A missing, invalid or non-https value adds nothing, so a bad value can
 * never widen the list. Pure, so the Vite config can call it and tests can cover it.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} host names, without ports or paths, de-duplicated in the order they are named.
 */
export function previewAllowedHosts(env) {
  const hosts = new Set();
  for (const name of ["APP_URL", "PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
    const raw = env[name];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname === "" || url.hostname.includes("*")) continue;
    hosts.add(url.hostname);
  }
  return [...hosts];
}
