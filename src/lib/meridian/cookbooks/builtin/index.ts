// The built-in cookbooks (round 3, K7): the registry the library, the resolver and the server functions read. Each is valid (its own tests
// check that) and read-only: a workspace changes one by forking it.

import type { Cookbook } from "../schema.ts";
import { FACTORY_PRESET_NAMES, blankCookbook, factoryPresetCookbook } from "./factory-presets.ts";
import { threeDDataExplainerCookbook } from "./three-d-data-explainer.ts";
import { ugcProductCookbook, voiceListicleCookbook } from "./more-built-ins.ts";
import { CODED_STYLE_COOKBOOKS } from "./coded-styles.ts";

export function builtinCookbooks(): Cookbook[] {
  return [
    threeDDataExplainerCookbook,
    ugcProductCookbook,
    voiceListicleCookbook,
    ...CODED_STYLE_COOKBOOKS,
    ...FACTORY_PRESET_NAMES.map((name) => factoryPresetCookbook(name)),
    blankCookbook("brief"),
    blankCookbook("reference"),
    blankCookbook("studio"),
  ];
}

/** A built-in cookbook by id. Built-ins have one version each: the version field says which. Undefined when no built-in has the id. */
export function builtinCookbook(cookbookId: string, version?: number): Cookbook | undefined {
  return builtinCookbooks().find((cookbook) => cookbook.cookbookId === cookbookId && (version === undefined || cookbook.version === version));
}

/** Whether an id belongs to a built-in cookbook (the store reserves these ids). */
export function isBuiltinId(cookbookId: string): boolean {
  return builtinCookbooks().some((cookbook) => cookbook.cookbookId === cookbookId);
}
