import { safeUrl, originPattern, sniffMedia } from "./media.js";
import { parsePlaylist, readLimited, decryptSegment } from "./hls.js";
import { TsAudioExtractor, validateAudio } from "./ts-audio.js";
import { isAudioHost } from "../audio-domains.js";

const PREFIX_BYTES = 64 * 1024;
const SEGMENT_BYTES = 2 * 1024 * 1024;
const MAX_TAG_OFFSET = 16 * 1024 * 1024;

class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function tagSize(bytes) {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 ||
      (bytes[5] & (bytes[3] === 2 ? 0x3f : bytes[3] === 3 ? 0x1f : 0x0f)) ||
      bytes.subarray(6, 10).some(byte => byte & 0x80)) throw new ProbeError("sample");
  return 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9] +
    (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
}

function audioSample(bytes) {
  for (let tags = 0; tags < 4; tags++) {
    const size = tagSize(bytes);
    if (!size) break;
    if (size > bytes.length) throw new ProbeError("sample");
    bytes = bytes.subarray(size);
  }
  const kind = sniffMedia(bytes);
  if (kind !== "aac" && kind !== "mp3") throw new ProbeError("format");
  return validateAudio(bytes, kind === "aac" ? 15 : 3, true);
}

// Automatic probes are restricted to the audio CDN. They never request new
// permissions or follow page-controlled URLs to unrelated authenticated sites.
function audioUrl(value) {
  const url = safeUrl(value);
  if (!isAudioHost(new URL(url).hostname)) throw new ProbeError("host");
  return url;
}

async function readPrefix(response, signal, start = 0) {
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
  if (!response.ok || (response.status === 206 && (!range || Number(range[1]) !== start ||
      Number(range[2]) < start || Number(range[2]) >= Number(range[3])))) {
    await response.body?.cancel();
    throw new ProbeError("http");
  }
  // Some servers ignore Range. Skip metadata locally, but never stream an
  // unbounded cover image just to estimate bitrate.
  let skip = response.status === 206 ? 0 : start;
  if (skip > SEGMENT_BYTES) { await response.body?.cancel(); throw new ProbeError("limit"); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError("sample");
  const result = new Uint8Array(PREFIX_BYTES);
  let size = 0;
  try {
    while (size < result.length) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const skipped = Math.min(skip, value.length); skip -= skipped;
      const part = value.subarray(skipped, skipped + result.length - size);
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
    if (!await hasPermission(originPattern(url))) throw new ProbeError("permission");
    try {
      return await fetchImpl(url, { headers, signal, credentials: "include", redirect: "error", cache: "no-store" });
    } catch (error) {
      signal.throwIfAborted();
      throw new ProbeError("network");
    }
  }
  const url = audioUrl(value);
  async function prefixAt(start) {
    let reply = await response(url, { Range: `bytes=${start}-${start + PREFIX_BYTES - 1}` });
    // Retry servers which reject ranged requests with a bounded ordinary GET.
    if ([400, 403, 405, 416].includes(reply.status)) {
      await reply.body?.cancel(); reply = await response(url);
    }
    return readPrefix(reply, signal, start);
  }
  let prefix = await prefixAt(0);
  let offset = 0;
  for (let tags = 0; tags < 4; tags++) {
    const size = tagSize(prefix);
    if (!size) break;
    offset += size;
    if (offset > MAX_TAG_OFFSET) throw new ProbeError("limit");
    prefix = size + 4096 <= prefix.length ? prefix.subarray(size) : await prefixAt(offset);
  }
  const kind = sniffMedia(prefix);
  let audio;
  if (kind === "mp3" || kind === "aac") {
    audio = audioSample(prefix);
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
    if (playlist?.kind !== "media" || playlist.init) throw new ProbeError("format");
    let extractor;
    let lastError;
    // Continue across up to three segments if the first ends inside a PES.
    // sample() does not consume the incomplete packet needed by the next push.
    for (let index = 0; index < Math.min(3, playlist.segments.length); index++) {
      const keyInfo = playlist.segmentKeys[index];
      let key;
      let bytes;
      try {
        if (keyInfo) key = await readLimited(await response(keyInfo.url), 16, signal);
        bytes = await readLimited(await response(playlist.segments[index]), SEGMENT_BYTES, signal);
        if (keyInfo) bytes = await decryptSegment(bytes, key, keyInfo.iv);
      } finally { key?.fill(0); }
      const isTs = bytes[0] === 0x47 && bytes[188] === 0x47;
      if (isTs) {
        extractor ||= new TsAudioExtractor();
        extractor.push(bytes);
        try { audio = extractor.sample(); } catch (error) { lastError = error; }
      } else {
        if (extractor) throw new ProbeError("format");
        audio = audioSample(bytes);
      }
      if (audio) break;
    }
    if (!audio) throw lastError || new ProbeError("sample");
  } else throw new ProbeError("format");
  const kbps = audio.bitrateKbps;
  if (!Number.isFinite(kbps) || kbps < 8 || kbps > 2000) throw new Error("Invalid bitrate");
  return { kbps, format: audio.extension, estimated: true };
}

export function createBitrateProbe({ fetchImpl = fetch, hasPermission, now = Date.now }) {
  const cache = new Map();
  const queue = [];
  let active = 0;
  function drain() {
    while (active < 2 && queue.length) {
      const task = queue.shift(); active++;
      task().finally(() => { active--; drain(); });
    }
  }
  const probe = (value, { retry = false } = {}) => {
    let url;
    try { url = audioUrl(value); } catch { return Promise.resolve(null); }
    const previous = cache.get(url);
    if (previous && (previous.pending || (previous.until > now() && !(retry && !previous.value && now() - previous.finished >= 5000)))) return previous.promise;
    if (queue.length >= 32) return Promise.resolve(null);
    if (cache.size >= 256) {
      const oldest = [...cache].find(([, item]) => !item.pending);
      if (oldest) cache.delete(oldest[0]);
    }
    const entry = { pending: true, until: 0 };
    entry.promise = new Promise(resolve => {
      queue.push(async () => {
        let value = null;
        try { value = await inspect(url, fetchImpl, hasPermission); }
        catch (error) { entry.reason = error.name === "TimeoutError" ? "timeout" : error.code || "sample"; }
        entry.pending = false;
        entry.value = value; entry.finished = now();
        entry.until = now() + (value ? 600000 : 60000);
        resolve(value);
      });
    });
    cache.set(url, entry);
    drain();
    return entry.promise;
  };
  probe.reason = value => {
    try { return cache.get(audioUrl(value))?.reason || "busy"; }
    catch { return "host"; }
  };
  probe.forget = value => { if (!cache.get(value)?.pending) cache.delete(value); };
  return probe;
}
