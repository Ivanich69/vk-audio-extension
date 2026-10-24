import { safeUrl } from "./media.js";

export const MAX_BYTES = 256 * 1024 * 1024;
export const MAX_SEGMENTS = 2000;

function attributes(line) {
  const output = {};
  const source = line.slice(line.indexOf(":") + 1);
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
  for (const match of source.matchAll(pattern)) output[match[1]] = match[2] ?? match[3];
  return output;
}

function parseIV(value) {
  if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(value)) throw new Error("Некорректный IV в HLS-плейлисте.");
  const hex = value.slice(2).padStart(32, "0");
  return Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
}

function sequenceIV(sequence) {
  if (sequence > 0xffffffffffffffffn) throw new Error("Некорректный номер HLS-сегмента.");
  return parseIV(`0x${sequence.toString(16)}`);
}

function parseKey(line, base, generation) {
  const attrs = attributes(line);
  if (attrs.METHOD === "NONE") {
    if (Object.keys(attrs).length !== 1) throw new Error("Некорректный METHOD=NONE в HLS.");
    return null;
  }
  if (attrs.METHOD !== "AES-128") {
    const method = /^[A-Z0-9-]{1,24}$/.test(attrs.METHOD || "") ? attrs.METHOD : "неизвестный";
    throw new Error(`Метод шифрования HLS ${method} не поддерживается. Поддержан AES-128; SAMPLE-AES и DRM пока не поддерживаются.`);
  }
  if ((attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity") || (attrs.KEYFORMATVERSIONS && attrs.KEYFORMATVERSIONS !== "1")) {
    throw new Error("Этот формат ключа HLS (KEYFORMAT/DRM) не поддерживается. Поддержан AES-128 с обычным 16-байтовым ключом.");
  }
  if (!attrs.URI) throw new Error("В HLS отсутствует адрес ключа AES-128.");
  return { url: safeUrl(attrs.URI, base), iv: attrs.IV === undefined ? null : parseIV(attrs.IV), generation };
}

export function parsePlaylist(text, base) {
  if (typeof text !== "string" || text.length > 1024 * 1024) throw new Error("Слишком большой HLS-плейлист.");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Сервер вернул не HLS-плейлист. Ссылка могла устареть.");
  const variants = [];
  const audio = [];
  const segments = [];
  const segmentKeys = [];
  let key = null;
  let keyGeneration = 0;
  let initKey = null;
  let sequence = 0n;
  let sequenceSeen = false;
  let variant;
  let init;
  let expectingSegment = false;
  let ended = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-KEY:")) {
      key = parseKey(line, base, ++keyGeneration);
    } else if (line.startsWith("#EXT-X-SESSION-KEY:")) {
      // A master session key is a preload hint, not a media segment key state.
      if (!parseKey(line, base, 0)) throw new Error("METHOD=NONE недопустим для HLS SESSION-KEY.");
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const value = line.slice(line.indexOf(":") + 1);
      if (sequenceSeen || segments.length || !/^\d{1,20}$/.test(value)) throw new Error("Некорректный номер HLS-сегмента.");
      sequence = BigInt(value);
      sequenceIV(sequence);
      sequenceSeen = true;
    } else if (/^#EXT-X-(BYTERANGE:|GAP$|DISCONTINUITY$|I-FRAMES-ONLY$|DEFINE:)/.test(line)) {
      throw new Error("Этот вариант HLS пока не поддерживается: Byte Range, пропуски или смена потока.");
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = attributes(line);
      if (attrs.BYTERANGE || !attrs.URI) throw new Error("HLS с Byte Range не поддерживается.");
      const next = safeUrl(attrs.URI, base);
      if (key && !key.iv) throw new Error("Для зашифрованного начального сегмента HLS требуется явный IV.");
      if (segments.length || (init && (init !== next || initKey !== key))) throw new Error("HLS со сменой начального сегмента не поддерживается.");
      init = next;
      initKey = key;
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = attributes(line);
      if (attrs.TYPE === "AUDIO" && attrs.URI) audio.push({ url: safeUrl(attrs.URI, base), default: attrs.DEFAULT === "YES" });
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      variant = attributes(line);
    } else if (line.startsWith("#EXTINF:")) {
      expectingSegment = true;
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!line.startsWith("#")) {
      if (variant) {
        variants.push({ url: safeUrl(line, base), bandwidth: Number(variant.BANDWIDTH) || 0, codecs: variant.CODECS || "", video: Boolean(variant.RESOLUTION || variant.VIDEO) });
        variant = undefined;
      } else if (expectingSegment) {
        segments.push(safeUrl(line, base));
        const iv = sequenceIV(sequence + BigInt(segments.length - 1));
        segmentKeys.push(key ? { ...key, iv: key.iv || iv } : null);
        expectingSegment = false;
        if (segments.length > MAX_SEGMENTS) throw new Error("Слишком много HLS-сегментов (лимит 2000).");
      } else {
        throw new Error("Некорректная структура HLS-плейлиста.");
      }
    }
  }
  if (expectingSegment || variant) throw new Error("HLS-плейлист обрезан.");
  if (audio.length || variants.length) {
    if (segments.length) throw new Error("Смешанный HLS-плейлист не поддерживается.");
    const selected = audio.find(item => item.default) || audio[0] || variants
      .filter(item => !item.video && item.codecs && item.codecs.split(",").every(codec => /^(mp4a|mp3|opus|flac|ac-3|ec-3)(\.|$)/i.test(codec.trim())))
      .sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!selected) throw new Error("В HLS не найден отдельный аудиопоток с известным кодеком.");
    return { kind: "master", url: selected.url };
  }
  if (!ended) throw new Error("Прямые эфиры и незавершённые HLS-потоки не поддерживаются.");
  if (!segments.length) throw new Error("В HLS-плейлисте нет сегментов.");
  return { kind: "media", segments, init, segmentKeys, initKey };
}

export async function decryptSegment(bytes, key, iv) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 16) throw new Error("Сервер вернул неверный ключ AES-128: требуется 16 байт.");
  if (!(iv instanceof Uint8Array) || iv.byteLength !== 16) throw new Error("Некорректный IV для AES-128.");
  if (!bytes.byteLength || bytes.byteLength % 16) throw new Error("Зашифрованный HLS-сегмент повреждён или обрезан.");
  try {
    const imported = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    // Web Crypto verifies and strips PKCS#7 padding required by HLS AES-128.
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, imported, bytes));
  } catch {
    throw new Error("Не удалось расшифровать HLS-сегмент: ключ, IV или данные не подходят. Включи трек заново и повтори попытку.");
  }
}

export function detectContainer(bytes, hasInit = false) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const box = String.fromCharCode(...b.subarray(4, 8));
  if (hasInit && box === "ftyp") return { extension: "mp4", mime: "video/mp4" };
  if (!hasInit && b.length >= 376 && b[0] === 0x47 && b[188] === 0x47) return { extension: "ts", mime: "video/mp2t" };
  let offset = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length >= 10) {
    if ([...b.subarray(6, 10)].some(value => value & 0x80)) throw new Error("Некорректный заголовок ID3.");
    offset = 10 + (b[6] << 21 | b[7] << 14 | b[8] << 7 | b[9]) + (b[5] & 0x10 ? 10 : 0);
  }
  if (!hasInit && b.length > offset + 7 && b[offset] === 0xff && (b[offset + 1] & 0xf6) === 0xf0) {
    return { extension: "aac", mime: "audio/aac" };
  }
  throw new Error("Неизвестный контейнер HLS. Файл не будет сохранён под неверным расширением.");
}

export async function readLimited(response, maxBytes, signal) {
  if (!response.ok || response.status === 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Сервер вернул HTTP ${response.status}. Включи трек заново и повтори попытку.`);
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Превышен лимит размера загрузки.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Сервер вернул пустой ответ.");
  const parts = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Превышен лимит размера загрузки (256 МБ для всего потока).");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("Сервер вернул пустой файл.");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
