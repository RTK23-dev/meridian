// Builds the single-file page that is published as an Artifact: the stylesheet and the scripts are inlined, and the body is kept as it is in
// index.html. The publish skeleton supplies the document wrapper, so the output starts with the title.
// Usage: node build-site.mjs <output.html>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");
const output = process.argv[2];
if (!output) {
  console.error("usage: node build-site.mjs <output.html>");
  process.exit(2);
}

const html = read("index.html");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const fonts = [...head.matchAll(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes("fonts.g"));
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script type="module" src="[^"]+"><\/script>/, "")
  .trim();

// The modules become one script, in dependency order. Imports and exports are removed; the names must not collide, so the build checks.
const modules = ["world-field.mjs", "map-model.mjs", "halftone.mjs", "site.mjs"].map((file) =>
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
</style>
${body}
<script type="module">
${script}
</script>
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, page);
console.log(`wrote ${output} (${Buffer.byteLength(page)} bytes, ${declared.length} top-level names, none repeated)`);
