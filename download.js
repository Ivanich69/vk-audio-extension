import { errorText, filename, identifyDownload, originPattern, safeUrl } from "./lib/media.js";
import { decryptSegment, detectContainer, MAX_BYTES, parsePlaylist, readLimited } from "./lib/hls.js";
import { TsAudioExtractor } from "./lib/ts-audio.js";

const el = id => document.getElementById(id);
let job;
let controller;
let running = false;
let pendingOrigins = [];
let blobUrl;
let downloadId;
let fallbackBlob;
let autoCloseDownloads = true;

class PermissionNeeded extends Error {
  constructor(origins) {
    super(`Для загрузки нужен доступ к серверам: ${origins.map(value => new URL(value).hostname).join(", ")}.`);
    this.origins = origins;
  }
}

function status(text, error = false) {
  el("status").textContent = text;
  el("status").className = error ? "error" : "";
}

async function ensurePermissions(urls) {
  const patterns = [...new Set(urls.map(originPattern))];
  const granted = await Promise.all(patterns.map(pattern => chrome.permissions.contains({ origins: [pattern] })));
  const missing = patterns.filter((_, index) => !granted[index]);
  if (missing.length) throw new PermissionNeeded(missing);
}

async function getResponse(value, options = {}) {
  const url = safeUrl(value);
  await ensurePermissions([url]);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
  let response;
  try {
    response = await fetch(url, { ...options, credentials: "include", redirect: "error", signal, cache: "no-store" });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("Не удалось получить файл. Возможны сетевая ошибка, перенаправление или устаревшая ссылка. Включи трек заново.");
  }
  return { response, signal };
}

async function getBytes(value, limit) {
  const { response, signal } = await getResponse(value);
  return readLimited(response, limit, signal);
}

async function save(url, extension) {
  status("Выбери, куда сохранить файл…");
  const id = await chrome.downloads.download({
    url, filename: `VK Audio/${filename(job.title, extension)}`,
    saveAs: true, conflictAction: "uniquify"
  });
  downloadId = id;
  status("Загрузка передана браузеру. Дождись завершения…");
  if (controller.signal.aborted) await chrome.downloads.cancel(id);
  const [item] = await chrome.downloads.search({ id });
  if (downloadId === id && item && item.state !== "in_progress") finish(item.state);
}

async function resolvePlaylist(url, initialBytes) {
  const visited = new Set();
  for (let depth = 0; depth < 4; depth++) {
    if (visited.has(url)) throw new Error("В HLS-плейлисте обнаружена циклическая ссылка.");
    visited.add(url);
    const bytes = depth === 0 && initialBytes ? initialBytes : await getBytes(url, 1024 * 1024);
    const playlist = parsePlaylist(new TextDecoder().decode(bytes), url);
    if (playlist.kind === "media") return playlist;
    url = playlist.url;
  }
  throw new Error("Слишком много вложенных HLS-плейлистов.");
}

function releaseBlob() {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = undefined;
}

function finish(state) {
  downloadId = undefined;
  releaseBlob();
  const closing = state === "complete" && autoCloseDownloads;
  running = closing;
  el("cancel").hidden = true;
  el("save-ts").hidden = closing || !fallbackBlob;
  el("start").hidden = closing;
  el("start").textContent = fallbackBlob ? "Повторить извлечение аудио" : state === "complete" ? "Сохранить ещё раз" : "Повторить";
  if (state === "complete") el("progress").value = el("progress").max;
  status(state === "complete" ? (closing ? "Файл сохранён. Закрываем вкладку…" : "Файл сохранён. Теперь можно закрыть вкладку.") : "Сохранение отменено или прервано. Подробности — в загрузках браузера.", state !== "complete");
  if (closing) closeOwnTab().catch(() => {
    running = false;
    el("start").hidden = false;
    el("save-ts").hidden = !fallbackBlob;
    status("Файл сохранён. Не удалось закрыть вкладку автоматически — её можно закрыть вручную.");
  });
}

async function closeOwnTab() {
  // getCurrent identifies this extension page, not the user's selected VK tab.
  const tab = await chrome.tabs.getCurrent();
  if (!Number.isInteger(tab?.id)) throw new Error("No download tab");
  await chrome.tabs.remove(tab.id);
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.id === downloadId && delta.state && ["complete", "interrupted"].includes(delta.state.current)) finish(delta.state.current);
});

async function run() {
  if (running || !job) return;
  running = true;
  controller = new AbortController();
  pendingOrigins = [];
  fallbackBlob = undefined;
  el("save-ts").hidden = true;
  el("diagnostics").hidden = true;
  el("diagnostic-text").value = "";
  el("start").textContent = "Повторить";
  el("grant").hidden = true;
  el("start").hidden = true;
  el("cancel").hidden = false;
  el("progress").value = 0;
  releaseBlob();
  const keys = new Map();
  try {
    el("format-hint").textContent = "Проверяем содержимое ссылки перед сохранением. Не закрывай вкладку до окончания загрузки.";
    el("progress").removeAttribute("value");
    status("Получаем аудио и проверяем формат…");
    const firstBytes = await getBytes(job.url, MAX_BYTES);
    controller.signal.throwIfAborted();
    const detected = identifyDownload(firstBytes);
    if (detected.kind !== "hls") {
      el("format-hint").textContent = `Формат файла: ${detected.kind.toUpperCase()}. Определён по содержимому; имя взято из данных трека.`;
      el("progress").max = 1; el("progress").value = 1;
      // Save the inspected bytes, not a second request to a possibly expired URL.
      blobUrl = URL.createObjectURL(new Blob([firstBytes], { type: detected.mime }));
      await save(blobUrl, detected.kind);
      return;
    }
    el("format-hint").textContent = "Извлечём MP3 или AAC из TS без потери качества. MP4 сохранится в исходном формате. Не закрывай вкладку до окончания загрузки.";
    status("Читаем HLS-плейлист…");
    const playlist = await resolvePlaylist(job.url, firstBytes);
    const urls = [...(playlist.init ? [playlist.init] : []), ...playlist.segments];
    const encryption = [...(playlist.init ? [playlist.initKey] : []), ...playlist.segmentKeys];
    await ensurePermissions([...urls, ...encryption.filter(Boolean).map(key => key.url)]);
    const parts = [];
    let size = 0;
    let container;
    el("progress").max = urls.length;
    el("progress").value = 0;
    for (let index = 0; index < urls.length; index++) {
      controller.signal.throwIfAborted();
      status(`Загружаем части потока: ${index + 1} из ${urls.length}…`);
      if (size >= MAX_BYTES) throw new Error("Превышен лимит размера потока (256 МБ).");
      const keyInfo = encryption[index];
      let rawKey;
      if (keyInfo) {
        rawKey = keys.get(keyInfo.generation);
        if (!rawKey) {
          status("Получаем ключ AES-128…");
          rawKey = await getBytes(keyInfo.url, 16);
          if (rawKey.byteLength !== 16) throw new Error("Сервер вернул неверный ключ AES-128: требуется 16 байт.");
          keys.set(keyInfo.generation, rawKey);
        }
        status(`Загружаем и расшифровываем части: ${index + 1} из ${urls.length}…`);
      }
      let bytes = await getBytes(urls[index], MAX_BYTES - size + (keyInfo ? 16 : 0));
      controller.signal.throwIfAborted();
      if (keyInfo) bytes = await decryptSegment(bytes, rawKey, keyInfo.iv);
      controller.signal.throwIfAborted();
      if (size + bytes.byteLength > MAX_BYTES) throw new Error("Превышен лимит размера потока (256 МБ).");
      if (index === 0) {
        container = detectContainer(bytes, Boolean(playlist.init));
      }
      else if (container.extension !== "mp4" && detectContainer(bytes).extension !== container.extension) {
        throw new Error("Формат сегментов HLS изменился. Сохранение остановлено.");
      } else if (container.extension === "mp4") {
        const box = String.fromCharCode(...bytes.subarray(4, 8));
        if (!["styp", "moof", "sidx", "emsg"].includes(box)) throw new Error("Некорректный MP4-сегмент HLS.");
      }
      size += bytes.byteLength;
      parts.push(bytes);
      el("progress").value = index + 1;
    }
    controller.signal.throwIfAborted();
    if (container.extension === "ts") {
      status("Проверяем извлечённое аудио…");
      const extractor = new TsAudioExtractor();
      let segmentIndex = 0;
      try {
        for (; segmentIndex < parts.length; segmentIndex++) extractor.push(parts[segmentIndex]);
        const audio = extractor.finish();
        container = audio;
        parts.length = 0;
        parts.push(audio.bytes);
      } catch (error) {
        // All segments have been fetched and decrypted. Offer the actual TS
        // explicitly; never label failed extraction as MP3 or save it silently.
        fallbackBlob = new Blob(parts, { type: "video/mp2t" });
        el("save-ts").hidden = false;
        el("format-hint").textContent = "Все части потока загружены. Можно сохранить исходный TS без повторной загрузки. Его воспроизведение зависит от плеера и целостности потока.";
        el("diagnostics").hidden = false;
        el("diagnostic-text").value = JSON.stringify({
          extensionVersion: chrome.runtime.getManifest().version,
          stage: "ts-extraction", segments: parts.length, downloadedBytes: size,
          segmentIndex: segmentIndex < parts.length ? segmentIndex : null,
          streamType: extractor.type ?? null, audioPid: extractor.audioPid ?? null,
          ...(error.diagnostics || {})
        }, null, 2);
        throw error;
      }
    }
    el("format-hint").textContent = `Формат файла: ${container.extension.toUpperCase()}. Аудио сохранено без перекодирования.`;
    blobUrl = URL.createObjectURL(new Blob(parts, { type: container.mime }));
    await save(blobUrl, container.extension);
  } catch (error) {
    running = false;
    releaseBlob();
    el("cancel").hidden = true;
    if (error instanceof PermissionNeeded && !controller.signal.aborted) {
      pendingOrigins = error.origins;
      status(error.message);
      el("grant").hidden = false;
    } else {
      status(controller.signal.aborted ? "Загрузка отменена." : errorText(error), !controller.signal.aborted);
      el("start").hidden = false;
    }
  } finally {
    for (const key of keys.values()) key.fill(0);
    keys.clear();
  }
}

el("grant").addEventListener("click", async () => {
  if (!pendingOrigins.length) return;
  el("grant").disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: pendingOrigins });
    if (granted) await run();
    else status("Доступ не предоставлен. Для сохранения разреши серверы аудио.");
  } catch (error) { status(errorText(error), true); }
  finally { el("grant").disabled = false; }
});
el("start").addEventListener("click", run);
el("save-ts").addEventListener("click", async () => {
  if (running || !fallbackBlob) return;
  running = true;
  controller = new AbortController();
  el("save-ts").hidden = true;
  el("start").hidden = true;
  el("cancel").hidden = false;
  releaseBlob();
  try {
    blobUrl = URL.createObjectURL(fallbackBlob);
    await save(blobUrl, "ts");
  } catch (error) {
    finish("interrupted");
    status(errorText(error), true);
  }
});
el("cancel").addEventListener("click", () => {
  controller?.abort();
  if (downloadId !== undefined) chrome.downloads.cancel(downloadId).catch(error => status(errorText(error), true));
});

async function init() {
  const settings = await chrome.storage.local.get("autoCloseDownloads");
  autoCloseDownloads = settings.autoCloseDownloads !== false;
  const id = new URL(location.href).searchParams.get("job");
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Некорректная ссылка на загрузку.");
  const key = `job:${id}`;
  const stored = await chrome.storage.session.get(key);
  job = stored[key];
  await chrome.storage.session.remove(key);
  if (!job || Date.now() - job.createdAt > 900000) throw new Error("Ссылка устарела. Открой расширение на вкладке ВКонтакте и выбери трек снова.");
  job.url = safeUrl(job.url);
  el("title").textContent = job.title;
  await run();
}
init().catch(error => {
  el("title").textContent = "Не удалось открыть загрузку";
  status(errorText(error), true);
});
