(() => {
  "use strict";
  const api = { isNoise(value) {
    try { const url = new URL(value); return /(^|\.)vk\.(com|ru)$/.test(url.hostname) && /\/bb[123]\.mp3$/i.test(url.pathname); }
    catch { return false; }
  } };
  const guard = Symbol.for("vk-audio.content.v3");
  if (window[guard]) return;
  window[guard] = true;
  const CHANNEL = "vk-audio-api-v3";
  let mainHealth = null;
  let devtoolsHealth = null;
  const suppressed = new Set();
  const tracks = new Map();
  const urls = new Map();
  const audioIds = new Map();
  const ignored = new Set();
  let context = { title: "", at: 0 };
  const ROW = ".audio_row, [data-audio], [data-audio-id]";
  const rowControls = new WeakMap();
  const rowClicks = new Map();
  let scanTimer;
  let notice;
  let noticeTimer;

  function rowData(row) {
    const raw = row.getAttribute("data-audio") || row.querySelector("[data-audio]")?.getAttribute("data-audio");
    if (!raw || raw.length > 65536) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function rowTrack(row) {
    const validId = value => typeof value === "string" && /^-?\d{1,24}_-?\d{1,24}$/.test(value) ? value : null;
    const data = rowData(row);
    const dataId = Array.isArray(data) ? validId(`${data[1]}_${data[0]}`) : data && validId(`${data.owner_id}_${data.id}`);
    const id = validId(row.getAttribute("data-full-id")) || validId(row.getAttribute("data-audio-id")) ||
      validId(row.id?.replace(/^audio/, "")) || dataId;
    const known = id && tracks.get(audioIds.get(id));
    if (known) return known;
    if (id && dataId && id !== dataId) return null;
    // An explicit URL in this row may be used before API metadata arrives.
    // Never match by title: distinct recordings can have identical names.
    const values = Array.isArray(data) ? [data[2]] : data ? [data.url] : [];
    for (const audio of row.querySelectorAll("audio")) values.push(audio.currentSrc || audio.src);
    for (const value of values) {
      if (typeof value !== "string" || !value) continue;
      try {
        const url = new URL(value, location.href); url.hash = "";
        const track = tracks.get(urls.get(url.href));
        if (track && (!id || !track.audioId || track.audioId === id)) return track;
      } catch { /* Ignore non-URL row fields. */ }
    }
    return null;
  }

  function showNotice(text) {
    if (!document.body) return;
    if (!notice?.host.isConnected) {
      const host = document.createElement("span");
      host.setAttribute("data-vk-audio-notice", "");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial;position:fixed;pointer-events:none;right:20px;bottom:20px;z-index:2147483647;max-width:min(360px,calc(100vw - 40px))}:host([hidden]){display:none}div{font:14px/1.5 system-ui,sans-serif;color:#fff;background:#1d2b3d;border-radius:12px;padding:12px 16px;box-shadow:0 4px 24px #0004;overflow-wrap:anywhere}";
      const text = document.createElement("div");
      text.setAttribute("role", "status"); text.setAttribute("aria-live", "polite");
      shadow.append(style, text); document.body.append(host);
      notice = { host, text };
    }
    notice.text.textContent = text;
    notice.host.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.host.hidden = true; }, 7000);
  }

  function updateControl(row, control) {
    const track = rowTrack(row);
    control.button.disabled = control.busy || !track;
    control.button.textContent = control.busy ? "…" : "↓";
    const label = track ? `Скачать: ${track.title}` : "Включи этот трек, чтобы VK передал ссылку для скачивания";
    control.host.title = label;
    control.button.setAttribute("aria-label", label);
  }

  async function downloadRow(event, row, control) {
    event.preventDefault(); event.stopPropagation();
    if (!event.isTrusted || control.busy || !row.isConnected) return;
    const track = rowTrack(row);
    if (!track) { updateControl(row, control); showNotice("Включи этот трек, дождись загрузки и нажми стрелку ещё раз."); return; }
    for (const [nonce, click] of rowClicks) if (Date.now() - click.at > 10000) rowClicks.delete(nonce);
    if (rowClicks.size >= 10) return;
    const nonce = crypto.randomUUID();
    rowClicks.set(nonce, { id: track.id, row, at: Date.now() });
    control.busy = true; updateControl(row, control);
    try {
      const result = await chrome.runtime.sendMessage({ type: "ROW_DOWNLOAD", id: track.id, nonce });
      if (!result?.ok) showNotice(result?.error || "Не удалось начать загрузку. Перезагрузи VK и повтори попытку.");
      else showNotice(result.background ? "Загрузка открыта в фоновой вкладке. Прогресс и ошибки доступны в ней." : "Открыта вкладка сохранения аудио.");
    } catch {
      showNotice("Не удалось связаться с расширением. Перезагрузи страницу VK после обновления расширения.");
    } finally {
      rowClicks.delete(nonce);
      control.busy = false; updateControl(row, control);
    }
  }

  function syncRowButtons() {
    for (const row of document.querySelectorAll(ROW)) {
      // Nested data-audio wrappers belong to the same visible audio row.
      if (row.parentElement?.closest(ROW)) continue;
      let control = rowControls.get(row);
      if (!control) {
        const host = document.createElement("span");
        host.setAttribute("data-vk-audio-download", "");
        const shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = ":host{all:initial;display:inline-flex;vertical-align:middle;margin-inline-start:6px;flex-shrink:0}button{box-sizing:border-box;width:28px;height:28px;border:0;border-radius:7px;padding:0;background:transparent;color:#5181b8;font:600 22px/28px system-ui,sans-serif;cursor:pointer}button:hover{background:#5181b822}button:focus-visible{outline:2px solid #5181b8;outline-offset:2px}button:disabled{opacity:.4;cursor:default}";
        const button = document.createElement("button"); button.type = "button";
        shadow.append(style, button);
        control = { host, button, busy: false };
        rowControls.set(row, control);
        // Stop events before VK's bubble handlers can start or pause playback.
        for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup", "keydown", "keyup", "dblclick"]) host.addEventListener(name, event => event.stopPropagation());
        host.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener("click", event => downloadRow(event, row, control));
      }
      const target = row.querySelector(".audio_row__actions") || row.querySelector(".audio_row__title") || row;
      if (control.host.parentElement !== target) target.append(control.host);
      updateControl(row, control);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; scan(); syncRowButtons(); }, 100);
  }

  function kindOf(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "https:") return null;
      if (url.href.includes("audio_api_unavailable")) return null;
      const ext = /\.(mp3|m4a|aac|ogg|opus|flac|wav|m3u8)$/i.exec(url.pathname)?.[1].toLowerCase();
      return ext === "m3u8" ? "hls" : ext || null;
    } catch { return null; }
  }

  function rowTitle(row) {
    if (!row) return "";
    const artist = row.querySelector(".audio_row__performers, .audio_row__performer")?.textContent?.trim();
    const title = row.querySelector(".audio_row__title_inner, .audio_row__title")?.textContent?.trim();
    return [artist, title].filter(Boolean).join(" — ").slice(0, 300);
  }

  function playerTitle() {
    // Browser metadata is available even when the player uses a blob/MSE URL.
    try {
      const metadata = navigator.mediaSession?.metadata;
      if (metadata?.title?.trim()) return [metadata.artist?.trim(), metadata.title.trim()].filter(Boolean).join(" — ").slice(0, 300);
    } catch { /* Fall back to the visible VK player. */ }
    const row = document.querySelector(".audio_row.audio_row__current, .audio_row.audio_row_current, .audio_row.audio_row_playing");
    const active = rowTitle(row);
    if (active) return active;
    for (const [songSelector, artistSelector] of [
      [".top_audio_player_title", ".top_audio_player_performer"],
      [".audio_page_player_title_song", ".audio_page_player_title_performer"]
    ]) {
      const song = document.querySelector(songSelector)?.textContent?.trim();
      const artist = document.querySelector(artistSelector)?.textContent?.trim();
      if (song) return [artist, song].filter(Boolean).join(" — ").slice(0, 300);
    }
    return "";
  }

  function fallbackTitle(url) {
    try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "Аудиозапись"; }
    catch { return "Аудиозапись"; }
  }

  function add(value, title = "", metadata) {
    if (!metadata && api.isNoise(value)) { suppressed.add(new URL(value, location.href).href); return; }
    const kind = kindOf(value) || (metadata ? "audio" : null);
    if (!kind) return;
    const url = new URL(value, location.href);
    url.hash = "";
    if (ignored.has(url.href)) return;
    const existing = tracks.get((metadata && audioIds.get(metadata.audioId)) || urls.get(url.href));
    if (existing) {
      if (metadata) {
        urls.delete(existing.url);
        existing.url = url.href;
        existing.kind = kind;
        Object.assign(existing, metadata, { source: "vk-api" });
        audioIds.set(metadata.audioId, existing.id);
        urls.set(url.href, existing.id);
      }
      if (title && (metadata || (existing.source !== "vk-api" && existing.titleSource !== "user"))) {
        existing.title = title.slice(0, 300);
        existing.titleSource = metadata ? "api" : "page";
      }
      return;
    }
    const track = {
      id: crypto.randomUUID(), url: url.href, kind,
      title: (title || fallbackTitle(url.href)).slice(0, 300),
      titleSource: metadata ? "api" : title ? "page" : "filename",
      foundAt: Date.now(), ...(metadata || {}), source: metadata ? "vk-api" : "page"
    };
    tracks.set(track.id, track);
    urls.set(url.href, track.id);
    if (metadata) audioIds.set(metadata.audioId, track.id);
    if (tracks.size > 1000) {
      const oldest = tracks.values().next().value;
      tracks.delete(oldest.id);
      urls.delete(oldest.url);
      if (oldest.audioId) audioIds.delete(oldest.audioId);
    }
  }

  function receiveTracks(items, forward = true) {
    if (!Array.isArray(items)) return;
    const accepted = [];
    // The page bridge is untrusted. Accept only bounded track metadata; no commands.
    for (const item of items.slice(0, 500)) {
      if (!item || typeof item.url !== "string" || item.url.length > 16384 ||
          typeof item.audioId !== "string" || !/^-?\d{1,24}_-?\d{1,24}$/.test(item.audioId) ||
          typeof item.artist !== "string" || typeof item.name !== "string") continue;
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:" || url.username || url.password || url.href.includes("audio_api_unavailable")) continue;
        const artist = item.artist.slice(0, 300);
        const name = item.name.slice(0, 300);
        const metadata = {
          audioId: item.audioId, artist, name,
          duration: Number.isFinite(item.duration) ? Math.max(0, Math.min(604800, Math.round(item.duration))) : 0
        };
        add(url.href, `${artist} — ${name}`, metadata);
        accepted.push({ ...metadata, url: url.href });
      } catch { /* Ignore malformed page messages. */ }
    }
    if (forward && window.top !== window && accepted.length) {
      chrome.runtime.sendMessage({ type: "FRAME_TRACKS", tracks: accepted }).catch(() => {});
    }
    scheduleScan();
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
    if (event.data.type === "TRACKS") receiveTracks(event.data.tracks);
    else if (event.data.type === "HEALTH" && event.data.state) {
      const state = event.data.state;
      mainHealth = { version: String(state.version || "").slice(0, 20), fetchHook: state.fetchHook === true, responseHook: state.responseHook === true };
      for (const key of ["responses", "parsed", "found", "missingUrls", "emptyUrls", "encodedUrls", "invalidUrls", "decodedUrls", "decodeFailed", "needsUserId", "errors", "oversized"]) {
        mainHealth[key] = Number.isFinite(state[key]) ? Math.max(0, Math.min(10000000, state[key])) : 0;
      }
      mainHealth.endpoint = typeof state.endpoint === "string" && /^\/[a-z0-9_./-]{0,100}$/i.test(state.endpoint) ? state.endpoint : "";
    }
  });

  document.addEventListener("click", event => {
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute("data-vk-audio-download"))) return;
    const row = event.target instanceof Element ? event.target.closest(ROW) : null;
    const title = rowTitle(row);
    if (title) context = { title, at: Date.now() };
  }, true);

  for (const name of ["play", "playing", "loadedmetadata"]) {
    document.addEventListener(name, event => {
      if (!(event.target instanceof HTMLAudioElement)) return;
      const audio = event.target;
      const title = rowTitle(audio.closest(ROW)) || audio.getAttribute("title") || (!audio.paused ? playerTitle() : "");
      add(audio.currentSrc || audio.src, title);
      scheduleScan();
    }, true);
  }

  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        // Only a request started AFTER a row click can use that row's name.
        // Buffered historical requests must not inherit the current player's name.
        const started = performance.timeOrigin + entry.startTime;
        const title = context.at && started >= context.at && started - context.at < 15000 ? context.title : "";
        add(entry.name, title);
      }
      scheduleScan();
    }).observe({ type: "resource", buffered: true });
  } catch { /* DOM sources remain available if resource timing is unavailable. */ }

  function scan() {
    for (const audio of document.querySelectorAll("audio")) {
      const title = rowTitle(audio.closest(ROW)) || audio.getAttribute("title") || (!audio.paused ? playerTitle() : "");
      add(audio.currentSrc || audio.src, title);
      for (const source of audio.querySelectorAll("source[src]")) add(source.src, title);
    }
    // Read only explicit, already present URLs; do not decode VK's private formats.
    const rows = document.querySelectorAll("[data-audio]");
    for (const row of Array.from(rows).slice(0, 500)) {
      const raw = row.getAttribute("data-audio");
      if (!raw || raw.length > 65536) continue;
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data) && typeof data[2] === "string") add(data[2], rowTitle(row));
      } catch { /* This is not an exposed audio URL. */ }
    }
    for (const link of document.querySelectorAll("a[download][href]")) add(link.href, link.getAttribute("download") || "");
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "LIST_TRACKS") {
      scan();
      syncRowButtons();
      window.postMessage({ channel: CHANNEL, type: "PING" }, location.origin);
      setTimeout(() => respond({
        tracks: [...tracks.values()].reverse(),
        playerTitle: playerTitle(),
        diagnostics: { contentVersion: "0.3.12", main: mainHealth, suppressedSounds: suppressed.size, namedTracks: [...tracks.values()].filter(track => track.titleSource !== "filename").length, apiTracks: [...tracks.values()].filter(track => track.source === "vk-api").length, playerAvailable: Boolean(playerTitle()), detectedStreams: [...tracks.values()].filter(track => track.kind === "hls").length, devtools: devtoolsHealth }
      }), 80);
      return true;
    } else if (message?.type === "CONSUME_ROW_DOWNLOAD") {
      const click = rowClicks.get(message.nonce);
      rowClicks.delete(message.nonce);
      const track = click && tracks.get(click.id);
      const allowed = click && click.id === message.id && Date.now() - click.at <= 10000 &&
        click.row.isConnected && track && rowTrack(click.row)?.id === track.id;
      respond({ track: allowed ? track : null });
    } else if (message?.type === "NAME_FROM_PLAYER" && sender.url === chrome.runtime.getURL("popup.html")) {
      const track = tracks.get(message.id);
      const title = playerTitle();
      if (!track || track.source === "vk-api") respond({ ok: false, error: "Обнови список треков." });
      else if (!title || title !== message.expectedTitle) respond({ ok: false, error: "Трек в плеере изменился. Обнови список и выбери название заново." });
      else {
        track.title = title;
        track.titleSource = "user";
        respond({ ok: true });
      }
    } else if (message?.type === "IMPORT_TRACKS") {
      receiveTracks(message.tracks, false);
      if (message.devtools) devtoolsHealth = message.devtools;
      respond({ ok: true });
    } else if (message?.type === "GET_TRACK") {
      respond({ track: [...tracks.values()].find(track => track.id === message.id) || null });
    } else if (message?.type === "CLEAR_TRACKS") {
      for (const track of tracks.values()) ignored.add(track.url);
      tracks.clear();
      urls.clear();
      audioIds.clear();
      rowClicks.clear();
      syncRowButtons();
      // Bound memory even during a long VK session.
      while (ignored.size > 1000) ignored.delete(ignored.values().next().value);
      respond({ ok: true });
    }
  });
  new MutationObserver(scheduleScan).observe(document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-audio", "data-full-id", "data-audio-id", "id"]
  });
  scheduleScan();
})();
