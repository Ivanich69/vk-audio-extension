import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Expected Manifest V3");
const declared = [manifest.background.service_worker, manifest.action.default_popup, manifest.devtools_page, ...manifest.content_scripts.flatMap(script => script.js)];
for (const file of declared) if (!statSync(resolve(root, file)).isFile()) throw new Error(`Missing ${file}`);
for (const file of ["popup.html", "download.html", "devtools.html"]) {
  const html = readFileSync(resolve(root, file), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`Inline script in ${file}`);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:)?\/\//.test(match[1])) throw new Error(`Remote resource in ${file}`);
    statSync(resolve(root, match[1]));
  }
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() && !["artifacts", ".browser-test"].includes(entry.name) ? walk(resolve(dir, entry.name)) : entry.isFile() && /\.(m?js)$/.test(entry.name) ? [resolve(dir, entry.name)] : []);
}
for (const file of walk(root)) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
  if (check.status !== 0) throw new Error(`${relative(root, file)}: ${check.stderr || check.error}`);
}
console.log("Manifest, declared files, CSP-compatible HTML and JavaScript syntax: OK");
