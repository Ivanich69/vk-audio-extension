import test from "node:test";
import assert from "node:assert/strict";
import { durationText, errorText, filename, identifyDownload, isVkPage, kindFromMime, mediaKind, originPattern, safeUrl, sniffMedia } from "../lib/media.js";
import { readFileSync } from "node:fs";

test("download verification recognizes real MP3/AAC bytes and HLS", () => {
  for (const [name, mime] of [["mp3", "audio/mpeg"], ["aac", "audio/aac"]]) {
    const bytes = readFileSync(new URL(`./fixtures/ts/${name}.audio`, import.meta.url));
    assert.deepEqual(identifyDownload(bytes), { kind: name, mime });
  }
  assert.equal(identifyDownload(new TextEncoder().encode("#EXTM3U\n#EXT-X-ENDLIST\n")).kind, "hls");
});

test("HTML, XML, JSON, plain errors and empty bodies never become audio", () => {
  for (const text of ["\uFEFF <!DOCTYPE html><html>login secret-value</html>", "<html>secret-value</html>", "<?xml version='1.0'?><error>secret-value</error>", '{"error":"secret-value"}', '["secret-value"]', "Access denied secret-value", ""]) {
    assert.throws(() => identifyDownload(new TextEncoder().encode(text)), error => {
      assert.match(error.message, /Файл не сохранён/);
      assert.equal(error.message.includes("secret-value"), false);
      return true;
    });
  }
});

test("MP3 with a large ID3 tag is identified from the complete downloaded body", () => {
  const audio = readFileSync(new URL("./fixtures/ts/mp3.audio", import.meta.url));
  const tag = new Uint8Array(10 + 16384);
  tag.set([73, 68, 51, 4, 0, 0, 0, 1, 0, 0]);
  const bytes = new Uint8Array(tag.length + audio.length);
  bytes.set(tag); bytes.set(audio, tag.length);
  assert.equal(identifyDownload(bytes).kind, "mp3");
});

test("VK host validation rejects lookalikes and other protocols", () => {
  for (const url of ["https://vk.com/audio", "https://m.vk.com/", "https://vk.ru/", "https://m.vk.ru/"]) assert.equal(isVkPage(url), true);
  for (const url of ["https://vk.com.evil.org/", "https://evilvk.com/", "http://vk.com/", "file:///vk.com", "bad"]) assert.equal(isVkPage(url), false);
});

test("download URLs reject local targets, credentials and port tricks", () => {
  for (const url of ["http://cdn.vk.com/a.mp3", "https://127.0.0.1/a.mp3", "https://0x7f000001/a.mp3", "https://[::1]/a.mp3", "https://localhost/a.mp3", "https://server.local/a.mp3", "https://intranet/a.mp3", "https://user:pass@cdn.vk.com/a.mp3", "https://cdn.vk.com:8443/a.mp3", "javascript:alert(1)"]) {
    assert.throws(() => safeUrl(url), undefined, url);
  }
  assert.equal(safeUrl("../audio.mp3?token=secret#fragment", "https://cdn.vk.com/stream/list.m3u8"), "https://cdn.vk.com/audio.mp3?token=secret");
  assert.equal(originPattern("https://cdn.vk.com/stream/a.m3u8?key=x"), "https://cdn.vk.com/*");
});

test("format detection uses the path, not token strings or fragment tricks", () => {
  assert.equal(mediaKind("https://cdn.vk.com/MUSIC.MP3?x=.exe"), "mp3");
  assert.equal(mediaKind("https://cdn.vk.com/a.m3u8?token=x"), "hls");
  assert.equal(mediaKind("https://cdn.vk.com/a.ts"), null);
  assert.equal(mediaKind("https://cdn.vk.com/a.exe?file=music.mp3"), null);
});

test("filenames remain single safe Unicode names on Windows", () => {
  assert.equal(filename("../Артист: Песня?.mp3", "mp3"), "Артист Песня.mp3");
  assert.equal(filename("CON", "mp3"), "_CON.mp3");
  assert.equal(filename("nul.txt", "aac"), "_nul.txt.aac");
  assert.equal(filename("\u202e..\\a/../b\u0000", "ts").includes("/"), false);
  assert.equal(filename("...", "mp3"), "Аудиозапись.mp3");
  assert.ok(Array.from(filename("я".repeat(500), "mp3")).length <= 144);
  assert.ok(filename("🎵".repeat(500), "mp3").length <= 144);
  assert.equal(filename("а".repeat(139) + "🎵", "mp3"), "а".repeat(139) + ".mp3");
  assert.throws(() => filename("file", "exe"));
});

test("display errors do not reveal signed URLs", () => {
  assert.equal(errorText(new Error("Failed https://cdn.vk.com/a.mp3?token=secret")), "Failed [ссылка]");
});

test("opaque audio links can be identified by MIME or file signatures", () => {
  assert.equal(kindFromMime("audio/mpeg; charset=binary"), "mp3");
  assert.equal(kindFromMime("application/vnd.apple.mpegurl"), "hls");
  assert.equal(kindFromMime("text/html"), null);
  assert.equal(kindFromMime("constructor"), null);
  assert.equal(sniffMedia(new TextEncoder().encode("\uFEFF#EXTM3U\n#EXTINF:1,")), "hls");
  assert.equal(sniffMedia(Uint8Array.from([0xff, 0xfb, 0x90, 0x64])), "mp3");
  assert.equal(sniffMedia(Uint8Array.from([0xff, 0xf1, 0x50, 0x80])), "aac");
  assert.equal(sniffMedia(new TextEncoder().encode("<html>login</html>")), null);
  assert.equal(durationText(198), "3:18");
});
