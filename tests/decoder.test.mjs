import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { maskedUrl } from "./encoded-fixtures.mjs";

const context = { URL };
runInNewContext(readFileSync(new URL("../audio-decoder.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../api-parser.js", import.meta.url), "utf8"), context);
const decoder = runInNewContext("globalThis[Symbol.for('vk-audio.decoder.v1')]", context);
const parser = runInNewContext("globalThis[Symbol.for('vk-audio.parser.v3')]", context);
const target = "https://cdn.vkuseraudio.ru/s/v1/song.mp3?siren=1&extra=a+b%2Fc";
const asPlain = value => JSON.parse(JSON.stringify(value));

test("VK URL decoder supports base64-only, reverse, rotation, xor and shuffling chains", () => {
  for (const operations of [[], [["v"]], [["r", 13]], [["x", "Q"]], [["s", 173]], [["i", 173]], [["r", 7], ["v"], ["x", "Q"], ["i", 173]]]) {
    assert.deepEqual(asPlain(decoder.decode(maskedUrl(target, operations, 123456), 123456)), { url: target, reason: "" });
  }
});

test("viewer-dependent masks require the current viewer ID and never use owner_id", () => {
  const encoded = maskedUrl(target, [["i", 173]], 123456);
  assert.equal(decoder.decode(encoded).reason, "needsUserId");
  assert.equal(decoder.decode(encoded, 777777).url, null);
  const payload = { audios: [[98, -76, encoded, "Название", "Исполнитель", 198]] };
  const absent = parser.extract(payload);
  assert.equal(absent.stats.needsUserId, 1);
  assert.equal(absent.stats.missingUrls, 1);
  assert.equal(absent.tracks.length, 0);
  const found = parser.extract(payload, false, 123456);
  assert.equal(found.stats.decodedUrls, 1);
  assert.equal(found.stats.encodedUrls, 1);
  assert.equal(found.stats.decodeFailed, 0);
  assert.equal(found.stats.missingUrls, 0);
  assert.equal(found.tracks[0].url, target);
  assert.equal(found.tracks[0].audioId, "-76_98");
  assert.equal(found.tracks[0].name, "Название");
});

test("decoded HLS preserves playlist URL and metadata", () => {
  const url = "https://cdn.vkuseraudio.ru/music/index.m3u8?extra=1";
  const found = parser.extract({ audios: [[98, -76, maskedUrl(url, [["s", 42]]), "Песня", "Артист", 198]] });
  assert.equal(found.tracks[0].url, url);
  assert.equal(found.stats.decodedUrls, 1);
  assert.equal(found.stats.missingUrls, 0);
});

test("decoder preserves literal plus, percent encoding, empty operation fragment and HTTPS validation", () => {
  const plain = maskedUrl(target);
  assert.equal(decoder.decode(plain.slice(0, -1)).url, target);
  const encodedQuery = plain.replace(/extra=([^#]*)/, (_, part) => `extra=${encodeURIComponent(part)}`);
  assert.equal(decoder.decode(encodedQuery).url, target);
  for (const invalid of ["http://cdn.vk.com/song.mp3", "javascript:alert(1)", "https://u:p@cdn.vk.com/song.mp3", "https://cdn.vk.com/a\n.mp3"]) {
    assert.equal(decoder.decode(maskedUrl(invalid)).url, null);
  }
});

test("malformed, unsupported, oversized masks and excessive work fail without throwing", () => {
  for (const invalid of ["https://vk.ru/audio_api_unavailable.mp3", maskedUrl(target).replace("vk.ru", "vk.ru.evil.org"), "https://vk.ru/audio_api_unavailable.mp3?extra=%%%#", "https://vk.ru/audio_api_unavailable.mp3?extra=" + "a".repeat(17000), maskedUrl(target, Array.from({ length: 17 }, () => ["v"]))]) {
    assert.equal(decoder.decode(invalid).url, null);
  }
  // 'q' is an unsupported instruction, encoded using VK's alphabet.
  const unsupported = maskedUrl(target).replace(/#$/, "#Cq");
  assert.equal(decoder.decode(unsupported).reason, "unsupported");
  const batch = parser.extract({ audios: Array.from({ length: 550 }, (_, id) => [id, 1, "https://vk.ru/audio_api_unavailable.mp3?extra=bad", "Название", "Артист", 198]) });
  assert.equal(batch.stats.truncated, true);
  assert.equal(batch.tracks.length, 0);
});
