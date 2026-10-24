import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const args of [["scripts/check.mjs"], ["--test", "tests/media.test.mjs", "tests/hls.test.mjs", "tests/page-api.test.mjs", "tests/devtools.test.mjs", "tests/decoder.test.mjs", "tests/ts-audio.test.mjs", "tests/background.test.mjs", "tests/download.test.mjs"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
const files = ["manifest.json", "background.js", "api-parser.js", "audio-decoder.js", "THIRD_PARTY.md", "licenses/vk_api-Apache-2.0.txt", "content.js", "page-api.js", "devtools.html", "devtools.js", "popup.html", "popup.js", "download.html", "download.js", "styles.css", "lib/media.js", "lib/hls.js", "lib/ts-audio.js", "README.md"];
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [];
const directory = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file);
  const data = readFileSync(resolve(root, file));
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // Fixed 1980-01-01 timestamp for reproducible archives.
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, central, end]);
const output = resolve(root, "artifacts");
mkdirSync(output, { recursive: true });
const name = `vk-audio-extension-${manifest.version}.zip`;
writeFileSync(resolve(output, name), zip);
writeFileSync(resolve(output, `${name}.sha256`), `${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
console.log(`Built ${resolve(output, name)} (${zip.length} bytes)`);
