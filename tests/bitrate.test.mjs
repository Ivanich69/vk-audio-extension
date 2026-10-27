import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCipheriv } from "node:crypto";
import { createBitrateProbe } from "../lib/bitrate.js";
import { validateAudio, TsAudioExtractor } from "../lib/ts-audio.js";
import { id3Tag, mp3Transport } from "./ts-metadata-fixtures.mjs";

const base = "https://cs1-77v4.vkuseraudio.ru/";
const fixture = name => readFileSync(new URL(`./fixtures/ts/${name}`, import.meta.url));
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.8,\npart.ts\n#EXT-X-ENDLIST";

test("MP3 with a large ID3 cover is probed after metadata using a bounded Range", async () => {
  const size = 180000;
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, size >> 21 & 127, size >> 14 & 127, size >> 7 & 127, size & 127]);
  const file = Buffer.concat([header, Buffer.alloc(size), fixture("mp3.audio")]);
  for (const ignoresRange of [false, true]) {
    const ranges = [];
    const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async (url, options) => {
      ranges.push(options.headers.Range);
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number);
      const last = Math.min(end, file.length - 1);
      return ignoresRange ? new Response(file) : new Response(file.subarray(start, last + 1), {
        status: 206, headers: { "Content-Range": `bytes ${start}-${last}/${file.length}` }
      });
    } });
    assert.equal((await probe(base + "cover.mp3")).kbps, 64);
    assert.deepEqual(ranges, ["bytes=0-65535", "bytes=180010-245545"]);
  }
});

test("Range rejection falls back to a bounded ordinary GET", async () => {
  let calls = 0;
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async (url, options) => {
    calls++;
    return options.headers.Range ? new Response(null, { status: 416 }) : new Response(fixture("mp3.audio"));
  } });
  assert.equal((await probe(base + "no-range.mp3")).kbps, 64);
  assert.equal(calls, 2);
});

test("HLS probe continues into a second segment when the first ends mid-PES", async () => {
  const transport = mp3Transport(fixture("mp3.audio"));
  const split = 6 * 188;
  const first = new TsAudioExtractor(); first.push(transport.subarray(0, split));
  assert.throws(() => first.finish(), /PES/);
  const paths = [];
  const text = playlist.replace("#EXT-X-ENDLIST", "#EXTINF:0.8,\nnext.ts\n#EXT-X-ENDLIST");
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    return new Response(url.endsWith("part.ts") ? transport.subarray(0, split) : url.endsWith("next.ts") ? transport.subarray(split) : text);
  } });
  assert.equal((await probe(base + "split.m3u8")).kbps, 64);
  assert.equal(paths.filter(p => p.endsWith(".ts")).length, 2);
});

test("HLS partial last audio frame is usable for a sample but still fails full-file validation", async () => {
  const transport = mp3Transport(fixture("mp3.audio").subarray(0, -1));
  const full = new TsAudioExtractor(); full.push(transport);
  assert.throws(() => full.finish(), /обрезан/);
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => new Response(url.endsWith(".ts") ? transport : playlist) });
  assert.equal((await probe(base + "partial.m3u8")).kbps, 64);
});

test("negative cache can be retried after cooldown and never leaks raw network errors", async () => {
  let time = 0, calls = 0;
  const probe = createBitrateProbe({ now: () => time, hasPermission: async () => true, fetchImpl: async () => {
    if (++calls === 1) throw new Error("https://private.example.org/?secret=token");
    return new Response(fixture("mp3.audio"));
  } });
  const url = base + "retry.mp3";
  assert.equal(await probe(url), null);
  assert.equal(probe.reason(url), "network");
  time = 4999;
  assert.equal(await probe(url, { retry: true }), null);
  assert.equal(calls, 1);
  time = 5000;
  assert.equal((await probe(url, { retry: true })).kbps, 64);
  assert.equal(calls, 2);
  await probe(url, { retry: true });
  assert.equal(calls, 2, "Successful samples are not repeatedly downloaded");
});

test("invalid and excessive metadata never triggers an unbounded cover fetch", async () => {
  for (const header of [Buffer.from([73,68,51,4,0,0,127,127,127,127]), Buffer.from([73,68,51,4,0,0,128,0,0,0])]) {
    let calls = 0;
    const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => { calls++; return new Response(header); } });
    assert.equal(await probe(base + "huge.mp3"), null);
    assert.equal(calls, 1);
  }
});

test("OK CDN roots and rotating servers support bitrate with existing permissions", async () => {
  const requests = [];
  const probe = createBitrateProbe({ hasPermission: async origin => {
    assert.match(origin, /^https:\/\/(?:[a-z0-9.-]+\.)?okcdn\.ru\/\*$/);
    return true;
  }, fetchImpl: async url => { requests.push(url); return new Response(fixture("mp3.audio")); } });
  for (const host of ["okcdn.ru", "vd546.okcdn.ru", "vd999.okcdn.ru", "nested.audio.okcdn.ru"]) {
    assert.equal((await probe(`https://${host}/song.mp3`)).kbps, 64);
  }
  assert.equal(requests.length, 4);
  for (const url of ["https://okcdn.ru.example.org/song.mp3", "https://fakeokcdn.ru/song.mp3", "https://okcdn.ru@other.org/song.mp3", "http://vd546.okcdn.ru/song.mp3", "https://vd546.okcdn.ru:8443/song.mp3"]) {
    assert.equal(await probe(url), null);
  }
  assert.equal(requests.length, 4, "Lookalike domains must never be fetched, even with optional permission");
});

test("cross-CDN HLS checks permission for the OK CDN segment and AES key", async () => {
  const key = Buffer.alloc(16, 7), iv = Buffer.alloc(16);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(fixture("mp3.ts")), cipher.final()]);
  const text = playlist.replace("part.ts", "https://vd546.okcdn.ru/part.ts")
    .replace("#EXTINF", '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.okcdn.ru/key"\n#EXTINF');
  for (const denied of [null, "keys.okcdn.ru", "vd546.okcdn.ru"]) {
    const requested = [];
    const probe = createBitrateProbe({ hasPermission: async origin => new URL(origin).hostname !== denied,
      fetchImpl: async url => {
        requested.push(url);
        return new Response(url.endsWith(".ts") ? encrypted : url.endsWith("/key") ? key : text);
      }
    });
    const result = await probe(base + "index.m3u8");
    if (denied) {
      assert.equal(result, null);
      assert.ok(requested.every(url => new URL(url).hostname !== denied));
    } else assert.equal(result.kbps, 64);
  }
});

test("MP3 64/32/16 kbps measured from audio frames, excluding ID3 metadata", async () => {
  for (const [name, rate] of [["mp3", 64], ["mp3-low", 32], ["mp3-lowest", 16]]) {
    const bytes = Buffer.concat([id3Tag(), fixture(`${name}.audio`)]);
    const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => new Response(bytes) });
    assert.deepEqual(await probe(base + name), { kbps: rate, format: "mp3", estimated: true });
  }
});

test("sample may end mid-frame, while normal download validation remains strict", () => {
  const bytes = fixture("mp3.audio").subarray(0, -1);
  assert.throws(() => validateAudio(bytes, 3), /обрезан/);
  assert.equal(validateAudio(bytes, 3, true).bitrateKbps, 64);
});

test("valid HTTP 206 prefix is measured without requiring the full file", async () => {
  const bytes = fixture("mp3.audio").subarray(0, 1000);
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => new Response(bytes, { status: 206, headers: { "Content-Range": "bytes 0-999/5851" } }) });
  assert.equal((await probe(base + "range.mp3")).kbps, 64);
});

test("master playlist follows the selected audio stream on the permitted CDN", async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\naudio.m3u8';
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => new Response(url.endsWith("master.m3u8") ? master : url.endsWith("audio.m3u8") ? playlist : fixture("mp3.ts")) });
  assert.equal((await probe(base + "master.m3u8")).kbps, 64);
});

test("full response to Range is cancelled after a bounded prefix and cache deduplicates", async () => {
  let cancelled = 0, reads = 0, calls = 0;
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.Range, "bytes=0-65535");
    assert.equal(options.redirect, "error");
    return new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(fixture("mp3.audio")); }, cancel() { cancelled++; } }));
  } });
  const [one, two] = await Promise.all([probe(base + "same"), probe(base + "same")]);
  assert.equal(one.kbps, 64); assert.deepEqual(one, two);
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.ok(reads < 15);
  await probe(base + "same"); assert.equal(calls, 1);
});

test("audio-only TS HLS estimates audio without transport overhead", async () => {
  for (const name of ["mp3", "aac"]) {
    const paths = [];
    const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => {
      paths.push(new URL(url).pathname);
      return new Response(url.endsWith("part.ts") ? fixture(`${name}.ts`) : playlist);
    } });
    const rate = await probe(base + "index.m3u8");
    assert.equal(rate.format, name);
    assert.equal(rate.kbps, name === "mp3" ? 64 : validateAudio(fixture("aac.audio"), 15).bitrateKbps);
    assert.equal(paths.filter(p => p.endsWith(".ts")).length, 1);
  }
});

test("AES-128 HLS sample uses the sequence IV and available CDN key", async () => {
  const key = Buffer.alloc(16, 7), iv = Buffer.alloc(16); iv[15] = 37;
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(fixture("mp3.ts")), cipher.final()]);
  const text = playlist.replace("#EXTINF", '#EXT-X-MEDIA-SEQUENCE:37\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF');
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => new Response(url.endsWith("part.ts") ? encrypted : url.endsWith("/key") ? key : text) });
  assert.equal((await probe(base + "index.m3u8")).kbps, 64);
});

test("missing permission, unrelated domains, redirects and HTML never invent a bitrate", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("<html>private</html>"); };
  const probe = createBitrateProbe({ hasPermission: async () => false, fetchImpl });
  for (const url of [base + "song.mp3", "https://127.0.0.1/x", "https://vkuseraudio.ru.example.org/x", "https://vk.com/al_audio.php"]) assert.equal(await probe(url), null);
  assert.equal(calls, 0);
  const allowed = createBitrateProbe({ hasPermission: async () => true, fetchImpl });
  assert.equal(await allowed(base + "fake.mp3"), null);
  const redirected = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://example.org/private" } }) });
  assert.equal(await redirected(base + "redirect"), null);
});

test("partial responses must start at byte zero; oversized and protected HLS samples fail", async () => {
  const wrongRange = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => new Response(fixture("mp3.audio"), { status: 206, headers: { "Content-Range": "bytes 100-5950/6000" } }) });
  assert.equal(await wrongRange(base + "wrong"), null);
  for (const protectedStream of [false, true]) {
    const text = protectedStream ? playlist.replace("#EXTINF", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF') : playlist;
    const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async url => new Response(url.endsWith("part.ts") ? new Uint8Array(2 * 1024 * 1024 + 1) : text) });
    assert.equal(await probe(base + "index.m3u8"), null);
  }
});

test("global probe concurrency and queue are bounded", async () => {
  let active = 0, maximum = 0, calls = 0;
  const probe = createBitrateProbe({ hasPermission: async () => true, fetchImpl: async () => {
    active++; calls++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response(fixture("mp3.audio"));
  } });
  const results = await Promise.all(Array.from({ length: 45 }, (_, i) => probe(base + i)));
  assert.equal(maximum, 2); assert.equal(calls, 34);
  assert.equal(results.filter(Boolean).length, 34);
});
