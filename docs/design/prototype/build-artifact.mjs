// Builds the single-file page that is published as an Artifact: the stylesheets and the scripts are inlined, and the page content is
// kept as it is in the entry's HTML. The publish skeleton supplies the document wrapper, so the output starts with the title.
// Usage: node build-artifact.mjs <output.html> [index|presentation]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

// Each entry names its page, its stylesheets in cascade order, and its modules in dependency order.
const ENTRIES = {
  index: { html: "index.html", css: ["prototype.css"], modules: ["model.mjs", "mount.mjs", "app.mjs"] },
  presentation: {
    html: "presentation.html",
    css: ["prototype.css", "presentation.css"],
    modules: ["model.mjs", "mount.mjs", "screens.mjs", "screens-start.mjs", "screens-workspace.mjs", "screens-settings.mjs", "screens-brand.mjs", "screens-all.mjs", "presentation.mjs"],
  },
};

const [output, name = "index"] = process.argv.slice(2);
if (!output || !ENTRIES[name]) {
  console.error("usage: node build-artifact.mjs <output.html> [index|presentation]");
  process.exit(2);
}
const entry = ENTRIES[name];

const html = read(entry.html);
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const fonts = [...head.matchAll(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes("fonts.g"));
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script type="module" src="[^"]+"><\/script>/, "")
  .trim();

// The modules become one script, in dependency order. Relative imports and exports are removed. Because the modules share one scope,
// a top-level name declared twice would be a syntax error in the page, so the build stops on it first.
const modules = entry.modules.map((file) =>
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
${entry.css.map(read).join("\n")}
</style>
${body}
<script type="module">
${script}
</script>
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, page);
console.log(`wrote ${output} (${name}, ${Buffer.byteLength(page)} bytes, ${declared.length} top-level names, none repeated)`);
