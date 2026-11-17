// Builds the committed runtime of the burette-clio Python package:
//   bundle/server.mjs          the merged stdio MCP server (one file, no node_modules)
//   bundle/views/*.html        the MCP Apps view resources (bridge code inlined)
//   bundle/assets/molstar.*    Burette's vendored, CSP-checked Mol* runtime
//   bundle/assets/ketcher/     Burette's Ketcher editor (vite build)
// Run from the repository root after `bun install`: bun packages/clio-burette/scripts/build.mjs
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(PACKAGE, "../..");
const BUNDLE = path.join(PACKAGE, "src/clio_burette/bundle");
const skipKetcher = process.argv.includes("--skip-ketcher");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

async function bundleBrowser(entry) {
  const out = path.join(BUNDLE, ".tmp", `${path.basename(entry, ".js")}.js`);
  // ext-apps ships a bun-built dist whose `typeof require` guards become an
  // undefined __require in IIFE output (see the hosted plugin build).
  run("bun", ["build", entry, "--outfile", out, "--target", "browser", "--format", "iife", "--minify", "--define", "require=undefined"]);
  const code = await readFile(out, "utf8");
  if (code.includes("__require")) throw new Error(`${entry} references an undefined __require.`);
  return code;
}

async function inlineView(template, entry, output) {
  const code = await bundleBrowser(entry);
  const html = await readFile(template, "utf8");
  const safe = code.replaceAll("</script", "<\\/script");
  await writeFile(output, html.replace("/*APP*/", () => safe));
}

await rm(path.join(BUNDLE, "views"), { recursive: true, force: true });
await rm(path.join(BUNDLE, "server.mjs"), { force: true });
await mkdir(path.join(BUNDLE, "views"), { recursive: true });
await mkdir(path.join(BUNDLE, "assets"), { recursive: true });

// 1. Server: one ESM file with the MCP SDK, zod and ext-apps/server inlined.
run("bun", ["build", path.join(PACKAGE, "server/index.mjs"), "--outfile", path.join(BUNDLE, "server.mjs"), "--target", "node", "--format", "esm", "--minify-syntax", "--minify-whitespace"]);

// 2. Views.
await inlineView(path.join(PACKAGE, "views/viewer/viewer.html"), path.join(PACKAGE, "views/viewer/app.js"), path.join(BUNDLE, "views/viewer.html"));
await inlineView(path.join(PACKAGE, "views/ketcher/ketcher.html"), path.join(PACKAGE, "views/ketcher/bootstrap.js"), path.join(BUNDLE, "views/ketcher.html"));

// 3. Mol*: the reviewed bundle from PreviewExtension/Web, with the same CSP check
// as the hosted plugin (no dynamic code generation), source map comments removed.
const molstar = (await readFile(path.join(REPO, "PreviewExtension/Web/molstar.js"), "utf8"))
  .replace(/\n\/\/# sourceMappingURL=molstar\.js\.map\s*$/u, "\n");
if (molstar.includes("new Function")) throw new Error("The vendored Mol* bundle contains dynamic code generation.");
await writeFile(path.join(BUNDLE, "assets/molstar.js"), molstar);
const molstarCss = (await readFile(path.join(REPO, "PreviewExtension/Web/molstar.css"), "utf8"))
  .replace(/\n\/\*# sourceMappingURL=molstar\.css\.map \*\/\s*$/u, "\n");
await writeFile(path.join(BUNDLE, "assets/molstar.css"), molstarCss);

// 4. Ketcher.
if (!skipKetcher) run(path.join(REPO, "node_modules/.bin/vp"), ["build", "--config", path.join(PACKAGE, "views/ketcher/vite.config.mjs")]);

await rm(path.join(BUNDLE, ".tmp"), { recursive: true, force: true });
await copyFile(path.join(REPO, "LICENSE"), path.join(BUNDLE, "LICENSE"));
await copyFile(path.join(REPO, "THIRD_PARTY_NOTICES.md"), path.join(BUNDLE, "THIRD_PARTY_NOTICES.md"));
// Ketcher and Indigo are Apache-2.0; ship the upstream license with the bundle.
const indigoLicense = path.join(REPO, "node_modules/.bun", (await import("node:fs")).readdirSync(path.join(REPO, "node_modules/.bun")).find((d) => d.startsWith("ketcher-standalone@")), "node_modules/indigo-ketcher/LICENSE");
await copyFile(indigoLicense, path.join(BUNDLE, "LICENSE-ketcher-indigo-apache-2.0.txt"));
console.log(`Built ${BUNDLE}`);
