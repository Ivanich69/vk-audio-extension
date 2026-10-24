const DIRECT = new Set(["mp3", "m4a", "aac", "ogg", "opus", "flac", "wav"]);

export function safeUrl(value, base) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Некорректная ссылка.");
  const url = new URL(value, base);
  const host = url.hostname.toLowerCase();
  // Do not let page-controlled URLs turn the extension into a local-network client.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":") ||
      /(?:^|\.)(?:localhost|local|lan|home|internal|test|invalid|example)$/.test(host)) {
    throw new Error("Поддерживаются только публичные HTTPS-ссылки без нестандартного порта.");
  }
  url.hash = "";
  return url.href;
}

export function isVkPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)vk\.(com|ru)$/.test(url.hostname);
  } catch { return false; }
}

export function mediaKind(value) {
  try {
    const path = new URL(value).pathname;
    const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
    return extension === "m3u8" ? "hls" : DIRECT.has(extension) ? extension : null;
  } catch { return null; }
}

export function kindFromMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  const kinds = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
    "audio/aac": "aac", "audio/aacp": "aac", "audio/ogg": "ogg", "application/ogg": "ogg",
    "audio/opus": "opus", "audio/flac": "flac", "audio/x-flac": "flac",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
    "application/vnd.apple.mpegurl": "hls", "application/x-mpegurl": "hls", "audio/mpegurl": "hls", "audio/x-mpegurl": "hls"
  };
  return Object.hasOwn(kinds, mime) ? kinds[mime] : null;
}

export function sniffMedia(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const prefix = new TextDecoder().decode(b.subarray(0, 64)).trimStart();
  if (prefix.startsWith("#EXTM3U")) return "hls";
  const text = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (text(0, 4) === "fLaC") return "flac";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "wav";
  if (text(0, 4) === "OggS") return new TextDecoder().decode(b.subarray(0, 128)).includes("OpusHead") ? "opus" : "ogg";
  if (text(4, 8) === "ftyp") return "m4a";
  let offset = 0;
  if (text(0, 3) === "ID3" && b.length >= 10) {
    if ([...b.subarray(6, 10)].some(value => value & 0x80)) return null;
    offset = 10 + (b[6] << 21 | b[7] << 14 | b[8] << 7 | b[9]) + (b[5] & 0x10 ? 10 : 0);
  }
  if (b.length < offset + 4 || b[offset] !== 0xff) return null;
  if ((b[offset + 1] & 0xf6) === 0xf0) return "aac";
  if ((b[offset + 1] & 0xe0) === 0xe0 && (b[offset + 1] & 0x18) !== 0x08 && (b[offset + 1] & 0x06) !== 0 &&
      (b[offset + 2] & 0xf0) !== 0xf0 && (b[offset + 2] & 0x0c) !== 0x0c) return "mp3";
  return null;
}

export function identifyDownload(bytes) {
  // Only actual bytes determine the saved format, never URL suffix, server MIME
  // or Content-Disposition. The same bytes must then be used for the download.
  const kind = sniffMedia(bytes);
  const mime = {
    mp3: "audio/mpeg", aac: "audio/aac", m4a: "audio/mp4", ogg: "audio/ogg",
    opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav", hls: "application/vnd.apple.mpegurl"
  };
  if (kind) return { kind, mime: mime[kind] };
  const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (prefix.startsWith("<")) {
    throw new Error("Сервер вернул HTML/XML-страницу вместо аудио. Файл не сохранён. Включи трек заново и снова нажми стрелку скачивания, чтобы получить свежую ссылку.");
  }
  if (prefix.startsWith("{") || prefix.startsWith("[")) {
    throw new Error("Сервер вернул ответ с данными вместо аудио. Файл не сохранён. Включи трек заново и снова нажми стрелку скачивания.");
  }
  throw new Error("В ответе сервера не найден поддерживаемый формат аудио. Файл не сохранён. Включи трек заново и снова нажми стрелку скачивания.");
}

export function durationText(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function filename(title, extension) {
  if (![...DIRECT, "ts", "mp4"].includes(extension)) throw new Error("Неизвестный формат файла.");
  let stem = String(title || "Аудиозапись").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "")
    .replace(/\.(mp3|m4a|aac|ogg|opus|flac|wav|m3u8|ts|mp4)$/i, "");
  stem = stem.slice(0, 140).replace(/[\ud800-\udbff]$/, "").replace(/[. ]+$/g, "") || "Аудиозапись";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${extension}`;
}

export function originPattern(url) {
  return `${new URL(safeUrl(url)).origin}/*`;
}

export function errorText(error) {
  const message = String(error?.message || error || "Неизвестная ошибка");
  // Signed media URLs may contain access tokens. Never show them in error messages.
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[ссылка]").slice(0, 500);
}
