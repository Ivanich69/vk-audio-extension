import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { maskedUrl } from "./encoded-fixtures.mjs";

const parser = readFileSync(new URL("../audio-decoder.js", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../api-parser.js", import.meta.url), "utf8");
const source = readFileSync(new URL("../devtools.js", import.meta.url), "utf8");
const apiUrl = "https://web.api.vk.ru/method/catalog.getSection?access_token=never-forward";
const audio = { id: 3, owner_id: -2, artist: "Артист", title: "Название", duration: 198, url: "https://cdn.vk.com/song.mp3?signed=media", access_key: "never-forward", track_code: "never-forward" };

function harness(entries = [], viewerId = 0) {
  const sent = [];
  const events = {};
  const chrome = {
    runtime: { connect: () => ({ onDisconnect: { addListener() {} } }), sendMessage: async message => { sent.push(JSON.parse(JSON.stringify(message))); return { ok: true }; } },
    devtools: {
      inspectedWindow: { tabId: 42, eval: (expression, callback) => {
        assert.equal(expression, "Number(window.vk?.id) || 0");
        callback(viewerId, undefined);
      } },
      network: { getHAR: callback => callback({ entries }), onRequestFinished: { addListener: callback => { events.finished = callback; } }, onNavigated: { addListener: callback => { events.navigated = callback; } } }
    }
  };
  const context = { chrome, URL, TextDecoder, atob, setTimeout, clearTimeout };
  runInNewContext(parser + "\n" + source, context);
  return { sent, events, context };
}
async function waitFor(h, predicate) {
  for (let i = 0; i < 100; i++) {
    const result = h.sent.find(predicate);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("DevTools capture did not publish expected data");
}
function entry(body, extra = {}) {
  return { startedDateTime: "2026-10-21T12:00:00Z", request: { url: apiUrl }, response: { status: 200, content: { size: 500 } }, getContent: callback => callback(body, ""), ...extra };
}

test("DevTools imports catalog bodies already in the Network log", async () => {
  const h = harness([entry(JSON.stringify({ response: { audios: [audio] } }))]);
  const message = await waitFor(h, item => item.tracks.length === 1);
  assert.equal(message.tabId, 42);
  assert.equal(message.tracks[0].name, "Название");
  assert.equal(JSON.stringify(message).includes("never-forward"), false);
});

test("DevTools decodes base64 JSONP with Unicode metadata and newer callback form", async () => {
  const body = Buffer.from(`vkCallback(${JSON.stringify({ audios: [audio] })});`).toString("base64");
  const h = harness();
  h.events.finished(entry(body, { getContent: callback => callback({ content: body, encoding: "base64" }) }));
  const message = await waitFor(h, item => item.tracks.length === 1);
  assert.equal(message.tracks[0].artist, "Артист");
});

test("DevTools ignores unrelated requests, deduplicates events and reports missing URLs", async () => {
  let reads = 0;
  const request = entry(JSON.stringify({ audios: [audio] }), { getContent: callback => { reads++; callback(JSON.stringify({ audios: [audio] }), ""); } });
  const h = harness([request]);
  h.events.finished(request);
  h.events.finished(entry("private", { request: { url: "https://web.api.vk.ru/method/messages.get" }, getContent: () => assert.fail("Read unrelated response") }));
  await waitFor(h, item => item.tracks.length === 1);
  assert.equal(reads, 1);
  h.events.finished(entry(JSON.stringify({ audios: [{ ...audio, url: "" }] }), { startedDateTime: "2026-10-21T12:00:01Z" }));
  const report = await waitFor(h, item => item.state.missingUrls === 1);
  assert.equal(report.state.responses, 2);
});

test("known VK notification assets are filtered without filtering music on a CDN", () => {
  const h = harness();
  assert.equal(runInNewContext("globalThis[Symbol.for('vk-audio.parser.v3')].isNoise('https://vk.ru/sound/bb2.mp3')", h.context), true);
  assert.equal(runInNewContext("globalThis[Symbol.for('vk-audio.parser.v3')].isNoise('https://cdn.vkuseraudio.ru/music/bb2.mp3')", h.context), false);
});

test("DevTools imports only audio attachments from messages.getHistory already in HAR", async () => {
  const body = { response: { items: [{
    text: JSON.stringify({ attachments: [{ type: "audio", audio: { ...audio, id: 999 } }] }),
    attachments: [{ type: "audio", audio }]
  }], profiles: [{ ...audio, id: 888 }] } };
  const h = harness([entry(JSON.stringify(body).replaceAll("/", "\\/"), { request: { url: "https://web.api.vk.ru/method/messages.getHistory?v=5.289&client_id=6287487" } })]);
  const message = await waitFor(h, item => item.tracks.length === 1);
  assert.equal(message.tracks[0].audioId, "-2_3");
  assert.equal(message.tracks[0].url, audio.url);
  assert.equal(JSON.stringify(message).includes("never-forward"), false);
  assert.equal(message.state.found, 1);
});

test("DevTools decodes masked audio with viewer context but publishes no viewer ID", async () => {
  const url = "https://cdn.vkuseraudio.ru/music/song.mp3?siren=1";
  const body = JSON.stringify({ payload: [0, [[[3, -2, maskedUrl(url, [["i", 173]], 123456), "Название", "Артист", 198]]]] });
  const h = harness([entry(body, { request: { url: "https://vk.ru/al_audio.php" } })], 123456);
  const message = await waitFor(h, item => item.tracks.length === 1);
  assert.equal(message.tracks[0].url, url);
  assert.equal(message.state.decodedUrls, 1);
  assert.equal(message.state.missingUrls, 0);
  assert.equal(JSON.stringify(message).includes("123456"), false);
});
