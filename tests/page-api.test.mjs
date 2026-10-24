import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { maskedUrl } from "./encoded-fixtures.mjs";

const source = readFileSync(new URL("../audio-decoder.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../api-parser.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../page-api.js", import.meta.url), "utf8");
const api = "https://web.api.vk.ru/method/catalog.getSection?v=5.289";
const audio = (extra = {}) => ({ id: 98, owner_id: -76, artist: "Исполнитель", title: "Название", duration: 198, url: "https://cdn.vk.com/s/v1/acmp/opaque?extra=temporary", access_key: "must-not-be-forwarded", track_code: "private", ...extra });
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function waitForTracks(messages) {
  for (let i = 0; i < 100 && !messages.length; i++) await delay();
  assert.ok(messages.length, "API detection did not publish track metadata");
}

function harness(body, headers = {}, rejectFetch = false) {
  const messages = [];
  const health = [];
  class PageResponse extends Response {}
  const response = new PageResponse(typeof body === "string" ? body : JSON.stringify(body), { headers });
  const nativePromise = rejectFetch ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(response);
  class XHR extends EventTarget {
    open(method, url) { this.method = method; this.requestUrl = url; }
    send() {}
    complete(body, type = "", status = 200) {
      this.status = status;
      this.responseURL = new URL(this.requestUrl, "https://vk.ru/audio").href;
      this.responseType = type;
      if (type === "json") this.response = body;
      else this.responseText = typeof body === "string" ? body : JSON.stringify(body);
      this.dispatchEvent(new Event("load"));
    }
  }
  const nativeOpen = XHR.prototype.open;
  const window = { fetch: () => nativePromise, Response: PageResponse, XMLHttpRequest: XHR, postMessage: (data, target) => {
    const entry = { data: JSON.parse(JSON.stringify(data)), target };
    if (data.type === "TRACKS") messages.push(entry);
    else health.push(entry.data.state);
  } };
  runInNewContext(source, { window, URL, location: { href: "https://vk.ru/audio", origin: "https://vk.ru" }, TextDecoder });
  return { window, messages, health, nativePromise, response, nativeOpen };
}

test("fetch finds screenshot-shaped catalog audio without consuming or replacing the response", async () => {
  const body = { response: { catalog: { sections: [{ blocks: [{ audios: [audio()] }] }] } } };
  const { window, messages, nativePromise } = harness(body);
  const result = window.fetch(api);
  assert.equal(result, nativePromise);
  assert.deepEqual(await (await result).json(), body);
  await waitForTracks(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, "https://vk.ru");
  assert.deepEqual(messages[0].data.tracks, [{ audioId: "-76_98", url: audio().url, artist: "Исполнитель", name: "Название", duration: 198 }]);
  assert.equal(JSON.stringify(messages).includes("must-not-be-forwarded"), false);
  assert.equal(JSON.stringify(messages).includes("track_code"), false);
});

test("XHR supports JSON, wrapped text, nested JSON strings, and reused request instances", () => {
  const { window, messages } = harness({});
  const xhr = new window.XMLHttpRequest();
  xhr.open("POST", "/al_audio.php?act=reload_audios");
  xhr.complete(`<!--${JSON.stringify({ payload: [0, [JSON.stringify({ audios: [[98, -76, "https://cdn.vk.com/song.mp3", "Название", "Исполнитель", 198]] })]] })}`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.tracks[0].name, "Название");
  xhr.open("POST", api);
  xhr.complete({ response: { audios: [audio({ title: "Обновлённое название" })] } }, "json");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].data.tracks[0].name, "Обновлённое название");
});

test("unrelated endpoints, lookalike hosts and errors are ignored", async () => {
  for (const url of ["https://web.api.vk.ru/method/messages.get", "https://vk.ru.evil.org/method/catalog.getSection", "https://cdn.vk.com/a.mp3", "http://vk.ru/method/catalog.getSection"]) {
    const { window, messages } = harness({ response: { audios: [audio()] } });
    await window.fetch(url);
    await delay();
    assert.equal(messages.length, 0, url);
  }
  const { window, messages } = harness({});
  const xhr = new window.XMLHttpRequest(); xhr.open("POST", api); xhr.complete({ audios: [audio()] }, "json", 403);
  assert.equal(messages.length, 0);
});

test("missing URLs, albums, invalid URLs and obfuscated entries are skipped", async () => {
  const { window, messages } = harness({ response: { audios: [
    audio({ url: "" }), audio({ url: "javascript:alert(1)" }), audio({ artist: null }),
    audio({ url: "https://vk.com/audio_api_unavailable.mp3" }), audio({ url: "https://u:p@cdn.vk.com/song.mp3" }),
    { id: 1, owner_id: 2, title: "Альбом", url: "https://cdn.vk.com/cover.jpg" }, audio()
  ] } });
  await window.fetch(api); await waitForTracks(messages);
  assert.equal(messages[0].data.tracks.length, 1);
});

test("duplicate identities use their latest URL and large batches are bounded", async () => {
  const { window, messages } = harness({ audios: [audio(), audio({ url: "https://cdn.vk.com/song.mp3?extra=updated" })] });
  await window.fetch(api); await waitForTracks(messages);
  assert.equal(messages[0].data.tracks.length, 1);
  assert.ok(messages[0].data.tracks[0].url.endsWith("updated"));
  const big = harness({ audios: Array.from({ length: 700 }, (_, id) => audio({ id })) });
  await big.window.fetch(api); await waitForTracks(big.messages);
  assert.equal(big.messages[0].data.tracks.length, 500);
  const oversized = harness({ audios: [audio()] }, { "content-length": String(17 * 1024 * 1024) });
  await oversized.window.fetch(api); await delay();
  assert.equal(oversized.messages.length, 0);
});

test("response readers still detect an API response when the page bypasses global fetch", async () => {
  const h = harness({ audios: [audio()] });
  Object.defineProperty(h.response, "url", { value: api });
  assert.equal((await h.response.json()).audios[0].title, "Название");
  await waitForTracks(h.messages);
  assert.equal(h.messages[0].data.tracks[0].audioId, "-76_98");
});

test("XHR send detects requests that use a cached native open method", () => {
  const h = harness({});
  const xhr = new h.window.XMLHttpRequest();
  h.nativeOpen.call(xhr, "POST", api);
  xhr.send();
  xhr.complete({ audios: [audio()] }, "json");
  assert.equal(h.messages.length, 1);
});

test("diagnostics distinguish missing URLs from no API responses", async () => {
  const h = harness({ audios: [audio({ url: "" })] });
  await h.window.fetch(api);
  for (let i = 0; i < 100 && !h.health.some(item => item.responses); i++) await delay();
  assert.equal(h.messages.length, 0);
  assert.equal(h.health.at(-1).responses, 1);
  assert.equal(h.health.at(-1).parsed, 1);
  assert.equal(h.health.at(-1).missingUrls, 1);
});

test("malformed API text never changes the page's successful response", async () => {
  const { window, messages } = harness("<!--not-json");
  assert.equal(await (await window.fetch(api)).text(), "<!--not-json");
  await delay();
  assert.equal(messages.length, 0);
});

test("missing URL diagnostics distinguish empty, encoded and rejected URLs without exposing values", async () => {
  const h = harness({ audios: [
    audio({ url: "" }), audio({ url: null }),
    audio({ url: "https://vk.ru/audio_api_unavailable.mp3?extra=private-value#hidden" }),
    audio({ url: "javascript:private-value" }), audio({ url: "https://u:p@cdn.vk.com/song.mp3" })
  ] });
  await h.window.fetch(api);
  for (let i = 0; i < 100 && !h.health.some(item => item.responses); i++) await delay();
  const state = h.health.at(-1);
  assert.equal(state.missingUrls, 5);
  assert.equal(state.emptyUrls, 2);
  assert.equal(state.encodedUrls, 1);
  assert.equal(state.invalidUrls, 2);
  assert.equal(JSON.stringify(h.health).includes("private-value"), false);
});

test("protocol-relative media URLs resolve to HTTPS", async () => {
  const h = harness({ audios: [audio({ url: "//cdn.vk.com/song.mp3" })] });
  await h.window.fetch(api); await waitForTracks(h.messages);
  assert.equal(h.messages[0].data.tracks[0].url, "https://cdn.vk.com/song.mp3");
});

test("unrelated failed fetches do not inflate music capture errors", async () => {
  const unrelated = harness({}, {}, true);
  await assert.rejects(unrelated.window.fetch("https://vk.ru/stats"));
  await delay();
  assert.equal(unrelated.health.at(-1).errors, 0);
  const music = harness({}, {}, true);
  await assert.rejects(music.window.fetch(api));
  await delay();
  assert.equal(music.health.at(-1).errors, 1);
});

const historyApi = "https://web.api.vk.ru/method/messages.getHistory?v=5.289&client_id=6287487";
const attachment = extra => ({ type: "audio", audio: audio({
  id: 428856953, owner_id: -43260601, artist: "Breezey Montana feat. Yanix",
  title: "Wow [Prod. By SK1ttless Beats]", url: "https://cdn.vkuseraudio.ru/s/v1/acmp/fixture.mp3?siren=1", ...extra
}) });

test("messages.getHistory extracts audio attachment with JSON escaped URL and exact metadata", async () => {
  const body = { response: { count: 1, items: [{ text: "private-message-text", attachments: [attachment()] }] } };
  const h = harness(JSON.stringify(body).replaceAll("/", "\\/"));
  const response = await h.window.fetch(historyApi);
  assert.deepEqual(await response.json(), body);
  await waitForTracks(h.messages);
  assert.deepEqual(h.messages[0].data.tracks, [{
    audioId: "-43260601_428856953", url: attachment().audio.url,
    artist: "Breezey Montana feat. Yanix", name: "Wow [Prod. By SK1ttless Beats]", duration: 198
  }]);
  assert.equal(JSON.stringify(h.messages).includes("private-message-text"), false);
  assert.equal(JSON.stringify(h.messages).includes("must-not-be-forwarded"), false);
});

test("history XHR follows forwarded and replied attachments but ignores text, profiles and other types", () => {
  const h = harness({});
  const xhr = new h.window.XMLHttpRequest();
  xhr.open("POST", historyApi);
  xhr.complete({ response: {
    profiles: [audio({ id: 777 })],
    items: [{
      text: JSON.stringify({ attachments: [attachment({ id: 888 })] }),
      attachments: [{ type: "video", audio: audio({ id: 999 }) }],
      fwd_messages: [{ attachments: [attachment()] }],
      reply_message: { attachments: [attachment({ id: 428856954 })] }
    }]
  } }, "json");
  assert.deepEqual(h.messages[0].data.tracks.map(track => track.audioId).sort(), ["-43260601_428856953", "-43260601_428856954"]);
});

test("history matching is limited to the exact method on VK HTTPS domains", async () => {
  for (const url of ["https://web.api.vk.ru/method/messages.getHistoryAttachments", "https://web.api.vk.ru/method/messages.getConversations", "https://vk.ru.evil.org/method/messages.getHistory", "http://vk.ru/method/messages.getHistory"]) {
    const h = harness({ response: { items: [{ attachments: [attachment()] }] } });
    await h.window.fetch(url); await delay();
    assert.equal(h.messages.length, 0, url);
    assert.equal(h.health.at(-1).responses, 0, url);
  }
});

test("al_audio.php XHR decodes viewer-bound music URLs while preserving track identity", () => {
  const h = harness({});
  h.window.vk = { id: 123456 };
  const url = "https://cdn.vkuseraudio.ru/music/index.m3u8?extra=keep+this";
  const xhr = new h.window.XMLHttpRequest();
  xhr.open("POST", "/al_audio.php?act=reload_audios");
  xhr.complete(`<!--${JSON.stringify({ payload: [0, [[[98, -76, maskedUrl(url, [["i", 173]], 123456), "Название", "Исполнитель", 198]]]] })}`);
  assert.equal(h.messages[0].data.tracks[0].url, url);
  assert.equal(h.messages[0].data.tracks[0].audioId, "-76_98");
  assert.equal(h.messages[0].data.tracks[0].name, "Название");
  assert.equal(h.health.at(-1).decodedUrls, 1);
  assert.equal(h.health.at(-1).missingUrls, 0);
  assert.equal(JSON.stringify(h.health).includes("123456"), false);
});
