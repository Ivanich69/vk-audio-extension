import { readFileSync, writeFileSync } from "node:fs";
import { AUDIO_DOMAINS } from "../audio-domains.js";

// Chrome reads permissions from manifest.json, not from the runtime domain list.
// Keep the manifest usable directly from a checkout or an unpacked release ZIP.
const path = new URL("../manifest.json", import.meta.url);
const source = readFileSync(path, "utf8");
const manifest = JSON.parse(source);
for (const domain of AUDIO_DOMAINS) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    throw new Error(`Expected a plain domain in audio-domains.js: ${domain}`);
  }
}
if (!AUDIO_DOMAINS.length || new Set(AUDIO_DOMAINS).size !== AUDIO_DOMAINS.length) throw new Error("Empty or duplicate audio domain list");
const origins = [...new Set([
  ...manifest.content_scripts.flatMap(script => script.matches),
  ...AUDIO_DOMAINS.map(domain => `https://*.${domain}/*`)
])];
const changed = JSON.stringify(manifest.host_permissions) !== JSON.stringify(origins);
if (process.argv.includes("--check")) {
  if (changed) throw new Error("Audio permissions are out of sync. Run: node scripts/sync-domains.mjs");
} else if (changed) {
  // Replace only the generated field to preserve the rest of the manifest.
  const block = '"host_permissions": [\n' + origins.map(origin => `    ${JSON.stringify(origin)}`).join(',\n') + '\n  ]';
  writeFileSync(path, source.replace(/"host_permissions"\s*:\s*\[[^\]]*\]/, block));
}
console.log(`Audio domain permissions: ${AUDIO_DOMAINS.join(", ")} (including subdomains)`);
