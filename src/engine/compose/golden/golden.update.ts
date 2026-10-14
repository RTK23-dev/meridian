// Writes the golden PNGs again from a fresh local render (Bible 17.3). Run with `npm run engine:golden:update`.
// Review every PNG by eye before committing: a golden frame is the reference the compare run checks against.

import { goldenSuite } from "./suite.ts";

goldenSuite(true);
