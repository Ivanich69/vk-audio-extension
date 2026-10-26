import { safeUrl, originPattern, sniffMedia } from "./media.js";
import { parsePlaylist, readLimited, decryptSegment } from "./hls.js";
import { TsAudioExtractor, validateAudio } from "./ts-audio.js";

const PREFIX_BYTES = 64 * 1024;
const SEGMENT_BYTES = 2 * 1024 * 1024;

// Automatic probes are restricted to the audio CDN. They never request new
// permissions or follow page-controlled URLs to unrelated authenticated sites.
function audioUrl(value) {
  const url = safeUrl(value);
  if (!/(^|\.)vkuseraudio\.ru$/.test(new URL(url).hostname)) throw new Error("Unsupported audio host");
  return url;
}

async function readPrefix(response, signal) {
  if (!response.ok || (response.status === 206 && !/^bytes 0-\d+\/\d+$/.test(response.headers.get("content-range") || ""))) {
    await response.body?.cancel();
    throw new Error("Invalid sample response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const result = new Uint8Array(PREFIX_BYTES);
  let size = 0;
  try {
    while (size < result.length) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, result.length - size);
      result.set(part, size); size += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return result.subarray(0, size);
}

async function inspect(value, fetchImpl, hasPermission) {
  const signal = AbortSignal.timeout(15000);
  async function response(value, headers = {}) {
    signal.throwIfAborted();
    const url = audioUrl(value);
    if (!await hasPermission(originPattern(url))) throw new Error("Permission missing");
    return fetchImpl(url, { headers, signal, credentials: "include", redirect: "error", cache: "no-store" });
  }
  const url = audioUrl(value);
  const prefix = await readPrefix(await response(url, { Range: `bytes=0-${PREFIX_BYTES - 1}` }), signal);
  const kind = sniffMedia(prefix);
  let audio;
  if (kind === "mp3" || kind === "aac") {
    audio = validateAudio(prefix, kind === "aac" ? 15 : 3, true);
  } else if (kind === "hls") {
    let next = url;
    const visited = new Set();
    let playlist;
    for (let depth = 0; depth < 4; depth++) {
      if (visited.has(next)) throw new Error("Playlist cycle");
      visited.add(next);
      const bytes = await readLimited(await response(next), 256 * 1024, signal);
      playlist = parsePlaylist(new TextDecoder().decode(bytes), next);
      if (playlist.kind === "media") break;
      next = playlist.url;
    }
    if (playlist?.kind !== "media" || playlist.init) throw new Error("Unsupported sample container");
    const keyInfo = playlist.segmentKeys[0];
    let key;
    let bytes;
    try {
      if (keyInfo) key = await readLimited(await response(keyInfo.url), 16, signal);
      bytes = await readLimited(await response(playlist.segments[0]), SEGMENT_BYTES, signal);
      if (keyInfo) bytes = await decryptSegment(bytes, key, keyInfo.iv);
    } finally { key?.fill(0); }
    if (bytes[0] === 0x47 && bytes[188] === 0x47) {
      const extractor = new TsAudioExtractor();
      extractor.push(bytes);
      audio = extractor.finish();
    } else {
      const kind = sniffMedia(bytes);
      if (kind !== "aac" && kind !== "mp3") throw new Error("Unsupported sample");
      audio = validateAudio(bytes, kind === "aac" ? 15 : 3);
    }
  } else throw new Error("Unknown format");
  const kbps = audio.bitrateKbps;
  if (!Number.isFinite(kbps) || kbps < 8 || kbps > 2000) throw new Error("Invalid bitrate");
  return { kbps, format: audio.extension, estimated: true };
}

export function createBitrateProbe({ fetchImpl = fetch, hasPermission }) {
  const cache = new Map();
  const queue = [];
  let active = 0;
  function drain() {
    while (active < 2 && queue.length) {
      const task = queue.shift(); active++;
      task().finally(() => { active--; drain(); });
    }
  }
  return value => {
    let url;
    try { url = audioUrl(value); } catch { return Promise.resolve(null); }
    const previous = cache.get(url);
    if (previous && (previous.pending || previous.until > Date.now())) return previous.promise;
    if (queue.length >= 32) return Promise.resolve(null);
    if (cache.size >= 256) {
      const oldest = [...cache].find(([, item]) => !item.pending);
      if (oldest) cache.delete(oldest[0]);
    }
    const entry = { pending: true, until: 0 };
    entry.promise = new Promise(resolve => {
      queue.push(async () => {
        let value = null;
        try { value = await inspect(url, fetchImpl, hasPermission); } catch { /* Unavailable is not a download error. */ }
        entry.pending = false;
        entry.until = Date.now() + (value ? 600000 : 60000);
        resolve(value);
      });
    });
    cache.set(url, entry);
    drain();
    return entry.promise;
  };
}
