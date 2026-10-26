(() => {
  "use strict";
  const api = globalThis[Symbol.for("vk-audio.parser.v3")];
  if (!api) return;
  const KEY = Symbol.for("vk-audio.capture.v3");
  const CHANNEL = "vk-audio-api-v3";
  const post = window.postMessage.bind(window);
  if (window[KEY]) { window[KEY].install(); return; }
  const state = { version: "0.3.13", responses: 0, parsed: 0, found: 0, missingUrls: 0, emptyUrls: 0, encodedUrls: 0, invalidUrls: 0, decodedUrls: 0, decodeFailed: 0, needsUserId: 0, errors: 0, oversized: 0, endpoint: "" };
  const consumed = new WeakSet();
  let fetchWrapper;
  let jsonWrapper;
  let textWrapper;
  let openWrapper;
  let sendWrapper;
  const urls = new WeakMap();
  const listening = new WeakSet();
  function health() {
    post({ channel: CHANNEL, type: "HEALTH", state: { ...state, fetchHook: window.fetch === fetchWrapper, responseHook: window.Response?.prototype.json === jsonWrapper } }, location.origin);
  }
  function inspect(payload, url) {
    state.responses++;
    try { state.endpoint = new URL(url, location.href).pathname.slice(0, 100); } catch { state.endpoint = ""; }
    let viewerId = 0;
    try { viewerId = Number(window.vk?.id) || 0; } catch { /* Page context may not be ready yet. */ }
    const result = api.extract(payload, api.isHistory(url, location.href), viewerId);
    if (result.stats.parsed) state.parsed++;
    else state.errors++;
    state.found += result.tracks.length;
    state.missingUrls += result.stats.missingUrls;
    for (const key of ["emptyUrls", "encodedUrls", "invalidUrls", "decodedUrls", "decodeFailed", "needsUserId"]) state[key] = (state[key] || 0) + result.stats[key];
    if (result.tracks.length) post({ channel: CHANNEL, type: "TRACKS", tracks: result.tracks }, location.origin);
    health();
  }
  async function inspectResponse(response, requested) {
    const url = response.url || requested;
    if (!response.ok || !api.isAudioApi(url, location.href) || consumed.has(response)) return;
    if (Number(response.headers.get("content-length")) > api.MAX_BODY) { state.oversized++; health(); return; }
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    consumed.add(response);
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > api.MAX_BODY) { reader.cancel().catch(() => {}); state.oversized++; health(); return; }
        text += decoder.decode(value, { stream: true });
      }
      inspect(text + decoder.decode(), url);
    } finally { reader.releaseLock(); }
  }
  function onXhrLoad(xhr) {
    try {
      const url = xhr.responseURL || urls.get(xhr);
      if (xhr.status < 200 || xhr.status >= 300 || !api.isAudioApi(url, location.href)) return;
      if (xhr.responseType === "json") inspect(xhr.response, url);
      else if (!xhr.responseType || xhr.responseType === "text") inspect(xhr.responseText, url);
    } catch { state.errors++; health(); }
  }
  function install() {
    if (typeof window.fetch === "function" && window.fetch !== fetchWrapper) {
      const previous = window.fetch;
      fetchWrapper = function (...args) {
        const promise = Reflect.apply(previous, this, args);
        const requested = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
        promise.then(response => {
          return inspectResponse(response, requested).catch(() => { state.errors++; health(); });
        }, () => {
          if (api.isAudioApi(requested, location.href)) { state.errors++; health(); }
        }).catch(() => {});
        return promise;
      };
      window.fetch = fetchWrapper;
    }
    const response = window.Response?.prototype;
    if (response && response.json !== jsonWrapper) {
      const previous = response.json;
      jsonWrapper = function (...args) {
        const promise = Reflect.apply(previous, this, args);
        if (api.isAudioApi(this.url, location.href) && !consumed.has(this)) {
          consumed.add(this);
          promise.then(value => inspect(value, this.url)).catch(() => { state.errors++; health(); });
        }
        return promise;
      };
      response.json = jsonWrapper;
    }
    if (response && response.text !== textWrapper) {
      const previous = response.text;
      textWrapper = function (...args) {
        const promise = Reflect.apply(previous, this, args);
        if (api.isAudioApi(this.url, location.href) && !consumed.has(this)) {
          consumed.add(this);
          promise.then(value => inspect(value, this.url)).catch(() => { state.errors++; health(); });
        }
        return promise;
      };
      response.text = textWrapper;
    }
    const xhr = window.XMLHttpRequest?.prototype;
    if (xhr && xhr.open !== openWrapper) {
      const previous = xhr.open;
      openWrapper = function (...args) {
        const result = Reflect.apply(previous, this, args);
        try { urls.set(this, String(args[1])); } catch { /* Native open already succeeded. */ }
        if (!listening.has(this)) { listening.add(this); this.addEventListener("load", () => onXhrLoad(this)); }
        return result;
      };
      xhr.open = openWrapper;
    }
    if (xhr?.send && xhr.send !== sendWrapper) {
      const previous = xhr.send;
      sendWrapper = function (...args) {
        if (!listening.has(this)) { listening.add(this); this.addEventListener("load", () => onXhrLoad(this)); }
        return Reflect.apply(previous, this, args);
      };
      xhr.send = sendWrapper;
    }
    health();
  }
  window[KEY] = { install };
  window.addEventListener?.("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === CHANNEL && event.data.type === "PING") install();
  });
  install();
})();
