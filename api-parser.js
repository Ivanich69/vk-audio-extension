(() => {
  "use strict";
  const MAX_BODY = 16 * 1024 * 1024;
  function isAudioApi(value, base) {
    try {
      const url = new URL(value, base);
      return url.protocol === "https:" && /(^|\.)vk\.(com|ru)$/.test(url.hostname) &&
        (/^\/method\/(?:catalog|audio)\.[a-z0-9_.]+\/?$/i.test(url.pathname) || /^\/al_(audio|catalog)\.php$/.test(url.pathname) || isHistory(url.href));
    } catch { return false; }
  }
  function isHistory(value, base) {
    try {
      const url = new URL(value, base);
      return url.protocol === "https:" && /(^|\.)vk\.(com|ru)$/.test(url.hostname) && /^\/method\/messages\.getHistory\/?$/i.test(url.pathname);
    } catch { return false; }
  }
  function isNoise(value) {
    try {
      const url = new URL(value);
      return /(^|\.)vk\.(com|ru)$/.test(url.hostname) && /\/bb[123]\.mp3$/i.test(url.pathname);
    } catch { return false; }
  }
  function parseText(text) {
    if (typeof text !== "string" || text.length > MAX_BODY) return null;
    let source = text.trim();
    if (source.startsWith("<!--")) source = source.slice(4).replace(/-->\s*$/, "").trim();
    source = source.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, "").replace(/^\)\]\}',?\s*/, "");
    const jsonp = /^[\w$.]+\(\s*([\[{][\s\S]*[\]}])\s*\);?\s*$/.exec(source);
    if (jsonp) source = jsonp[1];
    if (!/^[\[{]/.test(source)) return null;
    try { return JSON.parse(source); } catch { return null; }
  }
  function fieldsOf(value) {
    return Array.isArray(value) ? { id: value[0], owner_id: value[1], url: value[2], title: value[3], artist: value[4], duration: value[5] } : value;
  }
  function candidate(fields) {
    return typeof fields.artist === "string" && typeof fields.title === "string" &&
      /^-?\d{1,24}$/.test(String(fields.id)) && /^-?\d{1,24}$/.test(String(fields.owner_id));
  }
  function normalize(fields) {
    if (!candidate(fields) || typeof fields.url !== "string" || fields.url.length > 16384) return null;
    let url;
    try { url = new URL(fields.url.startsWith("//") ? `https:${fields.url}` : fields.url); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.href.includes("audio_api_unavailable")) return null;
    url.hash = "";
    return {
      audioId: `${fields.owner_id}_${fields.id}`, url: url.href,
      artist: fields.artist.trim().slice(0, 300) || "Неизвестный исполнитель",
      name: fields.title.trim().slice(0, 300) || "Без названия",
      duration: Number.isFinite(Number(fields.duration)) ? Math.max(0, Math.min(604800, Math.round(Number(fields.duration)))) : 0
    };
  }
  function extract(payload, attachmentsOnly = false, viewerId = 0, onCandidate) {
    const stats = { parsed: false, candidates: 0, missingUrls: 0, emptyUrls: 0, encodedUrls: 0, invalidUrls: 0, decodedUrls: 0, decodeFailed: 0, needsUserId: 0, truncated: false };
    if (typeof payload === "string") payload = parseText(payload);
    if (!payload || typeof payload !== "object") return { tracks: [], stats };
    stats.parsed = true;
    const stack = [{ value: payload, depth: 0 }];
    const seen = new WeakSet();
    const tracks = new Map();
    let nodes = 0;
    let strings = 0;
    while (stack.length && nodes++ < 100000 && tracks.size < 500) {
      let { value, depth } = stack.pop();
      if (depth > 50) { stats.truncated = true; continue; }
      if (!attachmentsOnly && typeof value === "string" && strings < 64 && /^\s*(?:[\[{]|<!--)/.test(value)) { strings++; value = parseText(value); }
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const fields = attachmentsOnly ? (value.type === "audio" ? value.audio : null) : fieldsOf(value);
      if (fields && candidate(fields)) {
        onCandidate?.(attachmentsOnly ? fields : value, fields);
        stats.candidates++;
        const encoded = typeof fields.url === "string" && fields.url.includes("audio_api_unavailable");
        let decoded;
        if (encoded) {
          stats.encodedUrls++;
          if (stats.encodedUrls <= 500) decoded = globalThis[Symbol.for("vk-audio.decoder.v1")]?.decode(fields.url, viewerId);
          else stats.truncated = true;
          if (decoded?.url) stats.decodedUrls++;
          else {
            stats.decodeFailed++;
            if (decoded?.reason === "needsUserId") stats.needsUserId++;
          }
        }
        const track = normalize(decoded?.url ? { ...fields, url: decoded.url } : fields);
        if (track) tracks.set(track.audioId, track);
        else {
          stats.missingUrls++;
          if (typeof fields.url !== "string" || !fields.url.trim()) stats.emptyUrls++;
          else if (!encoded) stats.invalidUrls++;
        }
      }
      // For message history follow only attachment containers, including replies
      // and forwarded messages. Never interpret message text as nested JSON.
      const values = attachmentsOnly && !Array.isArray(value)
        ? ["response", "items", "attachments", "fwd_messages", "reply_message"].map(key => value[key])
        : Object.values(value);
      const limit = Math.min(values.length, Math.max(0, 100000 - nodes - stack.length));
      if (limit < values.length) stats.truncated = true;
      for (let index = limit - 1; index >= 0; index--) {
        const child = values[index];
        if (child && (typeof child === "object" || typeof child === "string")) stack.push({ value: child, depth: depth + 1 });
      }
    }
    if (stack.length) stats.truncated = true;
    return { tracks: [...tracks.values()], stats };
  }
  globalThis[Symbol.for("vk-audio.parser.v3")] = Object.freeze({ MAX_BODY, isAudioApi, isHistory, isNoise, parseText, extract });
})();
