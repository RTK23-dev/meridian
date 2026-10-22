/**
 * The live-run readiness report (Content Factory plan, M2.0). For each provider category it says which deployment variable holds the
 * key, whether that variable is set, and whether the deployment's shared default is opted in. It reads names and booleans only. It
 * never returns a value, and it calls no provider.
 *
 * A workspace's own key is saved in Settings, encrypted, and is not in the environment, so this report cannot see it. Every row says
 * so. A category with no deployment variable named in the contract is reported as such, and nothing is guessed for it.
 */
import { DEPLOYMENT_ONLY_KEY_ENV, SHARED_DEFAULT_ENV, SOURCE_KEY_ENV } from "./contract.ts";

export type ReadinessEnv = Readonly<Record<string, string | undefined>>;

export type ReadinessRow = {
  category: string;
  /** The deployment variables the contract names for this category, in the order they are read. Empty when none is named. */
  keyVariables: readonly string[];
  /** True when one of the named variables is set to a non-blank value. Null when the contract names no variable. */
  deploymentKeySet: boolean | null;
  /** The shared-default switch, the value the contract accepts for it, and whether it is set to that value. */
  sharedDefault: { variable: string; accepts: string; optedIn: boolean };
};

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** The deployment key variables for the categories the live steps use. Source categories and the two deployment-only keys. */
function keyVariablesOf(category: string): readonly string[] {
  if (category in SOURCE_KEY_ENV) return SOURCE_KEY_ENV[category as keyof typeof SOURCE_KEY_ENV];
  if (category === "openrouter") return [DEPLOYMENT_ONLY_KEY_ENV.openrouter_chat.keyVariable];
  return [];
}

/**
 * One row for each category the contract names a shared default for. The order follows the contract, so the report is stable.
 */
export function readinessOf(env: ReadinessEnv): ReadinessRow[] {
  return Object.entries(SHARED_DEFAULT_ENV).map(([category, rule]) => {
    const keyVariables = keyVariablesOf(category);
    return {
      category,
      keyVariables,
      deploymentKeySet: keyVariables.length === 0 ? null : keyVariables.some((name) => isSet(env[name])),
      sharedDefault: { variable: rule.variable, accepts: rule.accepts, optedIn: env[rule.variable] === rule.accepts },
    };
  });
}

/** The text of the report: names and yes or no, with no value anywhere. */
export function renderReadiness(rows: readonly ReadinessRow[]): string {
  const lines = [
    "Live readiness (names and yes or no only; no value is printed).",
    "A workspace's own key is saved in Settings and is not in the environment, so it is not shown here.",
    "",
  ];
  for (const row of rows) {
    const key =
      row.deploymentKeySet === null
        ? "no deployment variable named in the contract"
        : `${row.keyVariables.join(" or ")}: ${row.deploymentKeySet ? "set" : "not set"}`;
    const shared = `${row.sharedDefault.variable}=${row.sharedDefault.accepts}: ${row.sharedDefault.optedIn ? "opted in" : "not opted in"}`;
    lines.push(`- ${row.category}: ${key}; ${shared}`);
  }
  return lines.join("\n");
}
