// Builds the single-file simulator for publishing: the page, its styles and its scripts inlined. The depth-field data is included so the
// spacing can be changed on the page. Usage: node build-tuner.mjs <output.html>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");
const output = process.argv[2];
if (!output) {
  console.error("usage: node build-tuner.mjs <output.html>");
  process.exit(2);
}

const html = read("tuner.html");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const fonts = [...head.matchAll(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes("fonts.g"));
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script type="module" src="[^"]+"><\/script>/, "").trim();

const modules = ["world-field.mjs", "map-model.mjs", "tuner.mjs"].map((file) =>
  read(file).replace(/^import [\s\S]*?from "\.\/[^"]+";\n/gm, "").replace(/^export /gm, ""),
);
const script = modules.join("\n");
if (/^import /m.test(script) || /^export /m.test(script)) throw new Error("an import or export was left in the inlined script");
const declared = [...script.matchAll(/^(?:const|let|var|function|class|async function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const repeated = declared.filter((n, i) => declared.indexOf(n) !== i);
if (repeated.length > 0) throw new Error(`top-level names declared twice in the inlined script: ${[...new Set(repeated)].join(", ")}`);

const page = `<title>${title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts.join("\n")}
<style>
${read("site.css")}
${read("tuner.css")}
</style>
${body}
<script type="module">
${script}
</script>
`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, page);
console.log(`wrote ${output} (${Buffer.byteLength(page)} bytes, ${declared.length} top-level names, none repeated)`);
