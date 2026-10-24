import { errorText, isVkPage, mediaKind, safeUrl } from "./lib/media.js";

async function ensureCapture(tabId, main = true) {
  if (!Number.isInteger(tabId)) throw new Error("Некорректная вкладка.");
  const tab = await chrome.tabs.get(tabId);
  if (!isVkPage(tab.url)) throw new Error("Открой вкладку ВКонтакте.");
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", files: ["content.js"] });
  if (main) await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["audio-decoder.js", "api-parser.js", "page-api.js"] });
  return { ok: true, version: "0.3.12" };
}

async function importTracks(tabId, tracks, devtools) {
  await ensureCapture(tabId, false);
  return chrome.tabs.sendMessage(tabId, { type: "IMPORT_TRACKS", tracks: Array.isArray(tracks) ? tracks.slice(0, 500) : [], devtools }, { frameId: 0 });
}

async function startDownload(message) {
  if (!Number.isInteger(message.tabId) || typeof message.id !== "string") throw new Error("Некорректный запрос.");
  const tab = await chrome.tabs.get(message.tabId);
  if (!isVkPage(tab.url)) throw new Error("Открой вкладку ВКонтакте.");
  const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_TRACK", id: message.id }, { frameId: 0 });
  if (!result?.track) throw new Error("Трек больше не доступен. Обнови список.");
  return downloadTrack(result.track);
}

async function startRowDownload(message, sender) {
  if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId < 0 ||
      typeof sender.documentId !== "string" || !isVkPage(sender.url) ||
      typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id) ||
      typeof message.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(message.nonce)) throw new Error("Некорректный запрос загрузки.");
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!isVkPage(tab.url)) throw new Error("Открой вкладку ВКонтакте.");
  // Ask the exact originating document to consume a one-use trusted-click grant.
  // Neither the page bridge nor message-supplied URLs can authorize a download.
  const result = await chrome.tabs.sendMessage(sender.tab.id, {
    type: "CONSUME_ROW_DOWNLOAD", id: message.id, nonce: message.nonce
  }, { documentId: sender.documentId });
  if (!result?.track || result.track.id !== message.id) throw new Error("Нажми кнопку скачивания рядом с треком ещё раз.");
  return downloadTrack(result.track);
}

async function downloadTrack(track) {
  const url = safeUrl(track.url);
  const kind = mediaKind(url) || (track.source === "vk-api" && track.audioId ? "audio" : null);
  if (!kind) throw new Error("Этот формат аудио пока не поддерживается.");
  const settings = await chrome.storage.local.get("backgroundDownloads");
  const background = settings.backgroundDownloads !== false;
  // Even a .mp3 URL can return a login/error page or a misleading MIME type.
  // Every source goes through byte inspection before the Save As dialog.
  const jobId = crypto.randomUUID();
  const key = `job:${jobId}`;
  await chrome.storage.session.set({ [key]: { url, kind, title: String(track.title).slice(0, 300), createdAt: Date.now() } });
  try {
    await chrome.tabs.create({ url: `${chrome.runtime.getURL("download.html")}?job=${jobId}`, active: !background });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  return { ok: true, separatePage: true, background };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Popup commands and verified clicks on row controls use separate routes.
  if (sender.id !== chrome.runtime.id) return;
  let action;
  if (sender.url === chrome.runtime.getURL("popup.html")) {
    if (message?.type === "START_DOWNLOAD") action = startDownload(message);
    else if (message?.type === "ENSURE_CAPTURE") action = ensureCapture(message.tabId);
  } else if (sender.tab && isVkPage(sender.url) && message?.type === "ROW_DOWNLOAD") {
    action = startRowDownload(message, sender);
  } else if (sender.url === chrome.runtime.getURL("devtools.html") && message?.type === "DEVTOOLS_CAPTURE") {
    const state = message.state || {};
    const devtools = { active: true };
    for (const key of ["responses", "parsed", "found", "missingUrls", "emptyUrls", "encodedUrls", "invalidUrls", "decodedUrls", "decodeFailed", "needsUserId", "errors", "oversized"]) devtools[key] = Number.isFinite(state[key]) ? Math.max(0, Math.min(10000000, state[key])) : 0;
    action = importTracks(message.tabId, message.tracks, devtools);
  } else if (sender.tab && sender.frameId > 0 && isVkPage(sender.url) && message?.type === "FRAME_TRACKS") {
    action = importTracks(sender.tab.id, message.tracks);
  }
  if (!action) return;
  action.then(respond, error => respond({ ok: false, error: errorText(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(() => {
  // Signed media links are temporary and must not build up indefinitely.
  chrome.storage.session.get(null).then(items => {
    const expired = Object.entries(items).filter(([key, job]) => key.startsWith("job:") && Date.now() - job.createdAt > 3600000).map(([key]) => key);
    if (expired.length) return chrome.storage.session.remove(expired);
  }).catch(() => {});
});

chrome.runtime.onConnect.addListener(port => {
  if (port.sender?.id !== chrome.runtime.id || port.sender.url !== chrome.runtime.getURL("devtools.html")) return;
  const match = /^vk-audio-devtools:(\d+)$/.exec(port.name);
  if (!match) return;
  port.onDisconnect.addListener(() => { importTracks(Number(match[1]), [], { active: false }).catch(() => {}); });
});
