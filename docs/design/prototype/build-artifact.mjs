// Builds the single-file page that is published as an Artifact: the stylesheet and both scripts are inlined, and the page content is
// kept as it is in index.html. The publish skeleton supplies the document wrapper, so the output starts with the title.
// Usage: node build-artifact.mjs <output.html>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");
const output = process.argv[2];
if (!output) {
  console.error("usage: node build-artifact.mjs <output.html>");
  process.exit(2);
}

const html = read("index.html");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const fonts = [...head.matchAll(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes("fonts.g"));
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script type="module" src="app\.mjs"><\/script>/, "")
  .trim();

// The modules become one script, in dependency order. Relative imports and exports are removed; the names do not collide.
const modules = ["model.mjs", "mount.mjs", "app.mjs"].map((name) =>
  read(name).replace(/^import [\s\S]*?from "\.\/[^"]+";\n/gm, "").replace(/^export /gm, ""),
);
const script = modules.join("\n");
if (/^import /m.test(script) || /^export /m.test(script)) throw new Error("an import or export was left in the inlined script");

const page = `<title>${title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts.join("\n")}
<style>
${read("prototype.css")}
</style>
${body}
<script type="module">
${script}
</script>
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, page);
console.log(`wrote ${output} (${Buffer.byteLength(page)} bytes)`);
