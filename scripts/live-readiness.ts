// Prints the live-run readiness report for the environment it runs in (Content Factory plan, M2.0). It prints names and yes or no,
// never a value, and it calls no provider. A workspace's own keys are saved in Settings and are not shown here.
//
// Usage: npm run live:readiness
import { readinessOf, renderReadiness } from "../src/lib/meridian/credentials/live-readiness.ts";

console.log(renderReadiness(readinessOf(process.env)));
