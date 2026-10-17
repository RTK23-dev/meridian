import { parseMediaFunctionsMode, type MediaFunctionsMode } from "../../../engine/media/mode.ts";

/**
 * The base URL of the engine's media functions on this deployment (MEDIA_FUNCTIONS_BASE_URL). The engine never reads the environment
 * (src/engine has no process.env): the production composition root reads the setting here and gives it to the gateway's providers
 * option (src/engine/gateway/providers.ts, media_functions). Unset, or not an https origin, the answer is null, so the media functions
 * stay NOT_CONNECTED and the gateway says so with its reason. A path is kept (the functions may sit under one); a query, a fragment or
 * credentials are refused, because the gateway builds request paths on this base.
 *
 * Nothing here calls the functions. Their host is not a secret, but it is not public either: the owner restricts it before the live run
 * (scripts/engine/STATUS.md, finding 3).
 */

/** The deployment setting that carries the media functions' base URL. */
export const MEDIA_FUNCTIONS_BASE_URL_SETTING = "MEDIA_FUNCTIONS_BASE_URL";

/** The base URL with no trailing slash, or null when the setting is unset or not a usable https origin. */
export function engineMediaFunctionsBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.MEDIA_FUNCTIONS_BASE_URL ?? "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * The media functions' mode on this deployment: "http" (the default, through MEDIA_FUNCTIONS_BASE_URL) or "in_process" (the ffmpeg
 * handlers run in the worker's own process). The rule is in src/engine/media/mode.ts: unset is "http", and any other value is a config
 * error, so a typo never picks a mode silently. The engine reads the value through this function, not from the environment itself.
 */
export function engineMediaFunctionsMode(env: NodeJS.ProcessEnv = process.env): MediaFunctionsMode {
  return parseMediaFunctionsMode(env.MEDIA_FUNCTIONS_MODE);
}
