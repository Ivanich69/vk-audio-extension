import { durationText, errorText, isVkPage, originPattern } from "./lib/media.js";

const el = id => document.getElementById(id);
let activeTab;
let busy = false;
const bitrateLabels = new WeakMap();
const bitrateObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const label = entry.target;
    const data = bitrateLabels.get(label);
    bitrateObserver.unobserve(label);
    if (!data || !label.isConnected) continue;
    label.textContent = "…";
    chrome.runtime.sendMessage({ type: "GET_BITRATE", tabId: data.tabId, id: data.track.id }).then(result => {
      if (!label.isConnected) return;
      const rate = result?.bitrate;
      const valid = result?.ok && result.url === data.track.url && Number.isInteger(rate?.kbps) && rate.kbps >= 8 && rate.kbps <= 2000;
      label.textContent = valid ? `≈${rate.kbps} кбит/с` : "— кбит/с";
      label.title = valid ? "Оценка по аудиокадрам фрагмента; средний битрейт при VBR может отличаться." : "Не удалось определить битрейт. Скачивание доступно.";
    }).catch(() => { if (label.isConnected) label.textContent = "— кбит/с"; });
  }
});
el("version").textContent = chrome.runtime.getManifest().version;

function showDiagnostics(diagnostics, injectionError = "") {
  const data = diagnostics || {};
  const main = data.main;
  const devtools = data.devtools;
  const responses = (main?.responses || 0) + (devtools?.responses || 0);
  el("recovery").hidden = data.apiTracks > 0;
  if (data.namedTracks > 0) el("capture-state").textContent = `Треков с названиями: ${data.namedTracks}.`;
  else if ((main?.needsUserId || 0) + (devtools?.needsUserId || 0) > 0) el("capture-state").textContent = "Для части ссылок не удалось получить данные текущего плеера. Перезагрузи VK и включи нужный трек.";
  else if ((main?.decodeFailed || 0) + (devtools?.decodeFailed || 0) > 0) el("capture-state").textContent = "Не удалось разобрать часть закодированных ссылок VK. Подробности — в диагностике; обнаруженные ниже потоки доступны отдельно.";
  else if (data.detectedStreams > 0) el("capture-state").textContent = "Аудиопоток найден. Его можно скачать. " + (data.playerAvailable ? "Если это трек в плеере, возьми его название кнопкой ниже." : "Название пока не определилось. Включи нужный трек и обнови список.");
  else if ((main?.missingUrls || 0) + (devtools?.missingUrls || 0) > 0) el("capture-state").textContent = "Записи найдены, но их ссылки пустые, закодированные или не подходят для загрузки. Включи нужный трек, чтобы обнаружить его поток.";
  else if (!main) el("capture-state").textContent = "Обработчик страницы не ответил. Доступен резервный захват через F12.";
  else if (!responses) el("capture-state").textContent = "Музыкальные ответы пока не получены. Открой плейлист или перезагрузи VK.";
  else el("capture-state").textContent = "Музыкальные ответы получены, но ссылки на треки не найдены. Подробности — в диагностике.";
  if (devtools?.active) el("capture-state").textContent += " Захват через DevTools включён.";
  el("diagnostics").value = JSON.stringify({
    extensionVersion: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    injectionError,
    ...data
  }, null, 2);
}

function status(text, error = false) {
  el("status").textContent = text;
  el("status").className = error ? "error" : "";
}

async function download(track, button) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  el("refresh").disabled = true;
  try {
    // This must run directly in the click handler to preserve the user gesture.
    const granted = await chrome.permissions.request({ origins: [originPattern(track.url)] });
    if (!granted) throw new Error("Для определения формата и загрузки нужен доступ к серверу аудио. Можно повторить попытку.");
    const result = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", tabId: activeTab.id, id: track.id });
    if (!result?.ok) throw new Error(result?.error || "Не удалось начать скачивание.");
    status(result.background ? "Загрузка открыта в фоновой вкладке. Прогресс и ошибки доступны в ней." : "Аудио открыто в отдельной вкладке загрузки.");
  } catch (error) { status(errorText(error), true); }
  finally {
    busy = false;
    el("refresh").disabled = false;
    button.disabled = false;
  }
}

function render(tracks, playerTitle = "") {
  bitrateObserver.disconnect();
  el("player-title").hidden = !playerTitle;
  el("player-title").textContent = playerTitle ? `В плеере: ${playerTitle}` : "";
  el("tracks").replaceChildren();
  el("count").textContent = `Найдено: ${tracks.length}`;
  el("empty").hidden = tracks.length !== 0;
  el("clear").hidden = tracks.length === 0;
  for (const track of tracks) {
    const row = document.createElement("li");
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = track.title;
    const detail = document.createElement("span");
    let host = "";
    try { host = new URL(track.url).hostname; } catch { /* validated again by the worker */ }
    detail.textContent = [durationText(track.duration), track.kind === "audio" ? "Аудио" : track.kind.toUpperCase(), host].filter(Boolean).join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Скачать";
    button.addEventListener("click", () => download(track, button));
    info.append(title, detail);
    if (playerTitle && track.source !== "vk-api" && track.title !== playerTitle) {
      const usePlayer = document.createElement("button");
      usePlayer.type = "button";
      usePlayer.className = "text-button name-from-player";
      usePlayer.textContent = "Взять название из плеера";
      usePlayer.title = playerTitle;
      usePlayer.addEventListener("click", async () => {
        if (busy) return;
        usePlayer.disabled = true;
        try {
          const result = await chrome.tabs.sendMessage(activeTab.id, { type: "NAME_FROM_PLAYER", id: track.id, expectedTitle: playerTitle }, { frameId: 0 });
          if (!result?.ok) throw new Error(result?.error || "Не удалось задать название.");
          await refresh();
        } catch (error) { status(errorText(error), true); }
        finally { usePlayer.disabled = false; }
      });
      info.append(usePlayer);
    }
    const actions = document.createElement("div"); actions.className = "download-actions";
    const bitrate = document.createElement("span"); bitrate.className = "bitrate";
    bitrate.textContent = "— кбит/с";
    bitrateLabels.set(bitrate, { track, tabId: activeTab?.id });
    actions.append(bitrate, button);
    row.append(info, actions);
    el("tracks").append(row);
    bitrateObserver.observe(bitrate);
  }
}

async function refresh() {
  if (busy) return;
  status("");
  el("refresh").disabled = true;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isVkPage(activeTab?.url)) throw new Error("Переключись на вкладку ВКонтакте и открой расширение снова.");
    let injectionError = "";
    try {
      const result = await chrome.runtime.sendMessage({ type: "ENSURE_CAPTURE", tabId: activeTab.id });
      if (!result?.ok) injectionError = result?.error || "Не удалось обновить обработчик.";
    } catch (error) { injectionError = errorText(error); }
    let response;
    try { response = await chrome.tabs.sendMessage(activeTab.id, { type: "LIST_TRACKS" }, { frameId: 0 }); }
    catch { throw new Error("Перезагрузи страницу ВКонтакте, включи трек и открой расширение снова."); }
    if (!Array.isArray(response?.tracks)) throw new Error("Не удалось получить список аудио.");
    render(response.tracks, response.playerTitle);
    showDiagnostics(response.diagnostics, injectionError);
  } catch (error) { render([]); status(errorText(error), true); }
  finally { el("refresh").disabled = false; }
}

el("refresh").addEventListener("click", refresh);
el("reload").addEventListener("click", async () => {
  if (!activeTab || busy) return;
  try {
    await chrome.tabs.reload(activeTab.id);
    status("Вкладка VK перезагружается. После загрузки открой музыку и нажми «Обновить».");
  } catch (error) { status(errorText(error), true); }
});
el("select-diagnostics").addEventListener("click", () => { el("diagnostics").focus(); el("diagnostics").select(); });
el("clear").addEventListener("click", async () => {
  if (busy || !activeTab) return;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "CLEAR_TRACKS" }, { frameId: 0 });
    render([]);
    status("Список очищен. Чтобы заново найти ту же ссылку, перезагрузи страницу ВКонтакте.");
  } catch (error) { status(errorText(error), true); }
});
async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get(["backgroundDownloads", "autoCloseDownloads"]);
    el("background-downloads").checked = settings.backgroundDownloads !== false;
    el("background-downloads").disabled = false;
    el("auto-close-downloads").checked = settings.autoCloseDownloads !== false;
    el("auto-close-downloads").disabled = false;
  } catch (error) { el("settings-status").textContent = errorText(error); }
}
for (const [id, key] of [["background-downloads", "backgroundDownloads"], ["auto-close-downloads", "autoCloseDownloads"]]) {
  el(id).addEventListener("change", async () => {
    const checkbox = el(id);
    const value = checkbox.checked;
    checkbox.disabled = true;
    try {
      await chrome.storage.local.set({ [key]: value });
      el("settings-status").textContent = "Сохранено. Применится к следующим загрузкам.";
    } catch (error) {
      checkbox.checked = !value;
      el("settings-status").textContent = errorText(error);
    } finally { checkbox.disabled = false; }
  });
}
loadSettings();
refresh();
