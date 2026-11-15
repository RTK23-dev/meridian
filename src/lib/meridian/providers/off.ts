import { DISABLED_CAPABILITIES, type DisabledCapability } from "./capability.ts";

/** True while every one of these actions is switched off in this version. */
export function isOff(...capabilities: DisabledCapability[]): boolean {
  return capabilities.every((capability) => capability in DISABLED_CAPABILITIES);
}
