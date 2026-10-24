import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { decryptSegment, detectContainer, MAX_SEGMENTS, parsePlaylist, readLimited } from "../lib/hls.js";

const base = "https://cdn.vk.com/path/list.m3u8?token=playlist";
const vod = (extras = "", segment = "a.ts?token=segment") => `#EXTM3U\n${extras}\n#EXTINF:5.0,\n${segment}\n#EXT-X-ENDLIST\n`;

test("VOD resolves relative segment and init URLs without copying playlist query tokens", () => {
  const result = parsePlaylist(vod('#EXT-X-MAP:URI="init.mp4?x=1,y=2"', "../a.m4s?key=own"), base);
  assert.equal(result.init, "https://cdn.vk.com/path/init.mp4?x=1,y=2");
  assert.deepEqual(result.segments, ["https://cdn.vk.com/a.m4s?key=own"]);
});

test("master selects default separate audio and highest compatible audio bitrate", () => {
  const result = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=NO,URI="low.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES,URI="high.m3u8"', base);
  assert.equal(result.url, "https://cdn.vk.com/path/high.m3u8");
  const variants = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.40.2"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="mp4a.40.2"\nhigh.m3u8', base);
  assert.equal(variants.url, "https://cdn.vk.com/path/high.m3u8");
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\nvideo.m3u8', base), /аудиопоток/);
});

test("unsupported or protected HLS is rejected before downloading segments", () => {
  for (const directive of ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMAT="com.apple.streamingkeydelivery"', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"']) {
    assert.throws(() => parsePlaylist(vod(directive), base), /не поддержива/);
  }
  assert.equal(parsePlaylist(vod("#EXT-X-KEY:METHOD=NONE"), base).kind, "media");
  for (const directive of ["#EXT-X-BYTERANGE:100@0", "#EXT-X-DISCONTINUITY", "#EXT-X-GAP", '#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"']) {
    assert.throws(() => parsePlaylist(vod(directive), base));
  }
  assert.throws(() => parsePlaylist(vod().replace("#EXT-X-ENDLIST", ""), base), /эфиры/);
  assert.throws(() => parsePlaylist(vod("", "https://127.0.0.1/a.ts"), base));
  assert.throws(() => parsePlaylist(vod("", "http://cdn.vk.com/a.ts"), base));
});

test("malformed playlists, changed init segments and oversized playlists fail clearly", () => {
  assert.throws(() => parsePlaylist("<html>login</html>", base), /не HLS/);
  assert.throws(() => parsePlaylist("#EXTM3U\n#EXTINF:5,\n#EXT-X-ENDLIST", base), /обрезан/);
  assert.throws(() => parsePlaylist("#EXTM3U\n#EXT-X-ENDLIST", base), /нет сегментов/);
  assert.throws(() => parsePlaylist(vod() + '#EXT-X-MAP:URI="new.mp4"', base), /сменой/);
  assert.throws(() => parsePlaylist("#EXTM3U\n" + "#EXTINF:5,\na.ts\n".repeat(MAX_SEGMENTS + 1) + "#EXT-X-ENDLIST", base), /много/);
});

test("containers are identified from bytes, never guessed to be MP3", () => {
  const ts = new Uint8Array(188 * 3); ts[0] = ts[188] = ts[376] = 0x47;
  assert.equal(detectContainer(ts).extension, "ts");
  const aac = Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0]);
  assert.equal(detectContainer(aac).extension, "aac");
  const tagged = new Uint8Array(10 + aac.length); tagged.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]); tagged.set(aac, 10);
  assert.equal(detectContainer(tagged).extension, "aac");
  assert.equal(detectContainer(Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]), true).extension, "mp4");
  assert.throws(() => detectContainer(new TextEncoder().encode("<html>server error</html>")), /контейнер/);
});

test("bounded response reader rejects HTTP errors, partial files and oversized chunked bodies", async () => {
  assert.deepEqual(await readLimited(new Response(Uint8Array.from([1, 2, 3])), 3), Uint8Array.from([1, 2, 3]));
  await assert.rejects(readLimited(new Response("denied", { status: 403 }), 100), /403/);
  await assert.rejects(readLimited(new Response("partial", { status: 206 }), 100), /206/);
  await assert.rejects(readLimited(new Response("big", { headers: { "content-length": "1000" } }), 10), /лимит/);
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimited(new Response(body), 10), /лимит/);
  assert.equal(cancelled, true);
  await assert.rejects(readLimited(new Response(new Uint8Array()), 100), /пустой/);
});

test("bounded reader cancels its stream when a user aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimited(new Response(body), 10, controller.signal), { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("AES-128 keys resolve relative URLs and IVs use full 64-bit media sequence", () => {
  const media = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin?token=key"\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST', base);
  assert.equal(media.segmentKeys[0].url, 'https://cdn.vk.com/keys/k.bin?token=key');
  assert.equal(Buffer.from(media.segmentKeys[0].iv).toString('hex'), '00000000000000000020000000000001');
  assert.equal(Buffer.from(media.segmentKeys[1].iv).toString('hex'), '00000000000000000020000000000002');
  assert.equal(media.segmentKeys[0].generation, media.segmentKeys[1].generation);
});

test("AES key rotation snapshots each segment, explicit IV and METHOD=NONE reset", () => {
  const media = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXTINF:2,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0xAB\n#EXTINF:2,\nb.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nc.ts\n#EXT-X-ENDLIST', base);
  assert.equal(media.segmentKeys[0].iv[15], 1);
  assert.equal(media.segmentKeys[1].iv[15], 0xab);
  assert.notEqual(media.segmentKeys[0].generation, media.segmentKeys[1].generation);
  assert.equal(media.segmentKeys[2], null);
});

test("encrypted init needs explicit IV and keeps its key when later segment keys change", () => {
  assert.throws(() => parsePlaylist(vod('#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"'), base), /явный IV/);
  const media = parsePlaylist(vod('#EXT-X-KEY:METHOD=AES-128,URI="init.key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="segment.key",IV=0x2', 'a.m4s'), base);
  assert.equal(media.initKey.url, 'https://cdn.vk.com/path/init.key');
  assert.equal(media.initKey.iv[15], 1);
  assert.equal(media.segmentKeys[0].iv[15], 2);
  assert.notEqual(media.initKey.generation, media.segmentKeys[0].generation);
  const master = parsePlaylist('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.40.2"\naudio.m3u8', base);
  assert.equal(master.kind, 'master');
});

test("bad IV, key URI, unsupported format and overflowing sequence fail before fetching", () => {
  for (const key of ['METHOD=AES-128', 'METHOD=AES-128,URI="http://cdn.vk.com/key"', 'METHOD=AES-128,URI="https://127.0.0.1/key"', 'METHOD=AES-128,URI="key",IV=0xZZ', 'METHOD=AES-128,URI="key",IV=0x' + 'f'.repeat(33), 'METHOD=AES-128,URI="key",KEYFORMATVERSIONS="2"', 'METHOD=NONE,URI="key"']) {
    assert.throws(() => parsePlaylist(vod('#EXT-X-KEY:' + key), base));
  }
  assert.throws(() => parsePlaylist(vod('#EXT-X-MEDIA-SEQUENCE:18446744073709551616'), base), /номер/);
  assert.throws(() => parsePlaylist(vod('#EXT-X-MEDIA-SEQUENCE:-1'), base), /номер/);
});

test("WebCrypto decrypts independently encrypted CBC segments with PKCS7 padding", async () => {
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  const iv = Uint8Array.from({ length: 16 }, (_, i) => 15 - i);
  for (const length of [1, 16, 188 * 3]) {
    const plain = Uint8Array.from({ length }, (_, i) => i & 255);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    assert.deepEqual(await decryptSegment(encrypted, key, iv), plain);
    await assert.rejects(decryptSegment(encrypted, new Uint8Array(15), iv), /16 байт/);
    await assert.rejects(decryptSegment(encrypted.subarray(1), key, iv), /повреждён/);
    const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 0x7f;
    await assert.rejects(decryptSegment(corrupt, key, iv), /расшифровать/);
  }
});
