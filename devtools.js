const api = globalThis[Symbol.for("vk-audio.parser.v3")];
const tabId = chrome.devtools.inspectedWindow.tabId;
const lifetime = chrome.runtime.connect({ name: `vk-audio-devtools:${tabId}` });
lifetime.onDisconnect.addListener(() => {});
const state = { responses: 0, parsed: 0, found: 0, missingUrls: 0, emptyUrls: 0, encodedUrls: 0, invalidUrls: 0, decodedUrls: 0, decodeFailed: 0, needsUserId: 0, errors: 0, oversized: 0 };
const seen = new Set();
let queue = Promise.resolve();

async function publish(tracks = []) {
  await chrome.runtime.sendMessage({ type: "DEVTOOLS_CAPTURE", tabId, tracks, state }).catch(() => {});
}

function getContent(request) {
  // Callbacks also work on Chrome versions before the promise form was added.
  return new Promise(resolve => {
    request.getContent((content, encoding) => {
      // Accommodate both callback signatures used by Chromium versions.
      if (content && typeof content === "object") resolve(content);
      else resolve({ content, encoding });
    });
  });
}

function getViewerId() {
  return new Promise(resolve => {
    // Fixed read-only expression: neither URLs nor response data become code.
    const timer = setTimeout(() => resolve(0), 1500);
    try {
      chrome.devtools.inspectedWindow.eval("Number(window.vk?.id) || 0", (value, exception) => {
        clearTimeout(timer);
        if (value && typeof value === "object" && "result" in value) { exception = value.exceptionInfo; value = value.result; }
        resolve(!exception && Number.isSafeInteger(value) && value > 0 ? value : 0);
      });
    } catch { clearTimeout(timer); resolve(0); }
  });
}

async function readRequest(request) {
  if (!api.isAudioApi(request.request?.url) || request.response?.status < 200 || request.response?.status >= 300) return;
  const key = `${request.startedDateTime || ""}:${request.request.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  while (seen.size > 2000) seen.delete(seen.values().next().value);
  state.responses++;
  if (request.response?.content?.size > api.MAX_BODY) { state.oversized++; await publish(); return; }
  try {
    const result = await getContent(request);
    let text = result.content;
    if (typeof text !== "string" || !text) { state.errors++; await publish(); return; }
    if (text.length > Math.ceil(api.MAX_BODY * 4 / 3) + 4) { state.oversized++; await publish(); return; }
    if (result.encoding === "base64") {
      const bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
      if (bytes.length > api.MAX_BODY) { state.oversized++; await publish(); return; }
      text = new TextDecoder().decode(bytes);
    }
    if (text.length > api.MAX_BODY) { state.oversized++; await publish(); return; }
    const viewerId = text.includes("audio_api_unavailable") ? await getViewerId() : 0;
    const parsed = api.extract(text, api.isHistory(request.request.url), viewerId);
    if (parsed.stats.parsed) state.parsed++;
    else state.errors++;
    state.found += parsed.tracks.length;
    state.missingUrls += parsed.stats.missingUrls;
    for (const key of ["emptyUrls", "encodedUrls", "invalidUrls", "decodedUrls", "decodeFailed", "needsUserId"]) state[key] = (state[key] || 0) + parsed.stats[key];
    await publish(parsed.tracks);
  } catch { state.errors++; await publish(); }
}

function enqueue(request) { queue = queue.then(() => readRequest(request)).catch(() => {}); }
chrome.devtools.network.onRequestFinished.addListener(enqueue);
chrome.devtools.network.onNavigated.addListener(() => {
  seen.clear();
  for (const key of Object.keys(state)) state[key] = 0;
  queue = queue.then(() => publish()).catch(() => {});
});
chrome.devtools.network.getHAR(log => { for (const request of log?.entries || []) enqueue(request); });
publish();
