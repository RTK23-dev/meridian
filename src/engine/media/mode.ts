// Which media functions a deployment runs (Bible 15.2, owner decision 2026-10-16): the HTTP form (httpMediaFunctions, through the
// gateway, to the serverless functions) or the in-process form on the worker (local.ts, the ffmpeg handlers in this process). The
// composition root reads the setting outside src/engine, as it reads MEDIA_FUNCTIONS_BASE_URL, and passes the raw value here. This
// file reads no environment. An unset value is "http", which is NOT_CONNECTED without a base URL, so nothing runs by default. Any
// other value is a config error, so a typo never picks a mode silently.

import { EngineError } from "../contracts/errors.ts";

/** The deployment setting that names the mode. */
export const MEDIA_FUNCTIONS_MODE_SETTING = "MEDIA_FUNCTIONS_MODE";

export const MEDIA_FUNCTIONS_MODES = ["http", "in_process"] as const;

export type MediaFunctionsMode = (typeof MEDIA_FUNCTIONS_MODES)[number];

/** The mode the setting names: "http" when it is unset or blank, otherwise the one value it names. Anything else is refused. */
export function parseMediaFunctionsMode(raw: string | null | undefined): MediaFunctionsMode {
  const value = (raw ?? "").trim();
  if (value === "") {
    return "http";
  }
  if ((MEDIA_FUNCTIONS_MODES as readonly string[]).includes(value)) {
    return value as MediaFunctionsMode;
  }
  throw new EngineError(
    "config",
    `${MEDIA_FUNCTIONS_MODE_SETTING} must be one of ${MEDIA_FUNCTIONS_MODES.join(", ")}, not "${value.slice(0, 32)}"`,
    { stage: "media.client" },
  );
}
