// Independent reference files for the pure JS extractor. Not part of the extension.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const dir = fileURLToPath(new URL("../tests/fixtures/ts/", import.meta.url));
mkdirSync(dir, { recursive: true });
const ffmpeg = process.env.VK_TEST_FFMPEG || "C:\\ffmpeg\\bin\\ffmpeg.exe";
function run(args) {
  const result = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}
for (const [name, codec, rate] of [["aac", "aac", 44100], ["mp3", "libmp3lame", 44100], ["mp3-low", "libmp3lame", 22050], ["mp3-lowest", "libmp3lame", 11025]]) {
  const ts = `${dir}${name}.ts`;
  run(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}`, "-t", "0.7", "-c:a", codec, "-f", "mpegts", ts]);
  run(["-i", ts, "-map", "0:a:0", "-c:a", "copy", ...(codec === "aac" ? ["-f", "adts"] : ["-f", "mp3", "-write_xing", "0", "-id3v2_version", "0", "-write_id3v1", "0"]), `${dir}${name}.audio`]);
}
console.log(`Generated TS and reference audio fixtures: ${dir}`);
