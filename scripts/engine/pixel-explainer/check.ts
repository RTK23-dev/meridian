// Checks a directed film, and its pixel build when given, before anything is drawn: the direction check (direction/check.ts) and the
// crew's faithfulness (direction/faithful.ts). Exit code 1 when anything blocks.
//
//   node --experimental-strip-types scripts/engine/pixel-explainer/check.ts --film film.json [--build build.json]

import { directionFindings } from "../../../src/engine/direction/check.ts";
import { faithFindings } from "../../../src/engine/direction/faithful.ts";
import { loadBuild, loadFilm } from "./render.ts";

const args = process.argv.slice(2);
const arg = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const filmPath = arg("--film");
if (filmPath === undefined) {
  console.error("usage: check.ts --film film.json [--build build.json]");
  process.exit(2);
}
const film = loadFilm(filmPath);
const buildPath = arg("--build");
const findings = [...directionFindings(film), ...(buildPath ? faithFindings(film, loadBuild(buildPath)) : [])];
for (const finding of findings) console.log(`${finding.severity}: ${finding.rule} at ${finding.at}: ${finding.message}`);
const blocks = findings.filter((finding) => finding.severity === "block").length;
console.log(blocks === 0 ? `passes (${findings.length} warnings)` : `${blocks} blocking findings`);
process.exit(blocks === 0 ? 0 : 1);
