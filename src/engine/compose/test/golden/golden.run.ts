// Golden frames for the component library (Bible 17.3): compares each fixture's local render with its stored PNG.
// Run with `npm run engine:golden`. Not part of `npm test`: it needs a local Chrome headless shell
// (HYPERFRAMES_BROWSER_PATH) and ffmpeg, and it renders every fixture. To write the PNGs again, use
// `npm run engine:golden:update` (golden.update.ts) and review each one by eye before committing it.

import { goldenSuite } from "./suite.ts";

goldenSuite(false);
