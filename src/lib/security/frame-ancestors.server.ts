import { frameAncestorsSetting } from "../meridian/config/server-settings";
import { frameAncestorsPolicy } from "../../../scripts/frame-policy.mjs";

/**
 * The `frame-ancestors` rule the server sends on every response. It is read when the server starts, not when the app is built, so a
 * host can set MERIDIAN_FRAME_ANCESTORS in its runtime variables. A bad value is reported once and falls back to this app only.
 *
 * Server-only (`.server.ts`): the setting is read through its accessor in lib/meridian/config, the one place settings are read.
 */
const policy = frameAncestorsPolicy(frameAncestorsSetting());
for (const problem of policy.problems) {
  console.warn(`[frame-ancestors] MERIDIAN_FRAME_ANCESTORS: ${problem}. Only this app may frame Meridian.`);
}

export const frameAncestors = `frame-ancestors ${policy.value}`;
