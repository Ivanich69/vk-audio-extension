import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { errorText, filename, isVkPage, mediaKind, safeUrl } from "../lib/media.js";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const id = "12345678-1234-4234-8234-123456789abc";
const nonce = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
const track = { id, audioId: "-2_3", source: "vk-api", url: "https://cdn.vk.com/song.mp3?token=fixture", title: "Артист — Трек" };
const sender = { id: "extension", url: "https://vk.com/audio", tab: { id: 42 }, frameId: 7, documentId: "origin-document" };
function harness(approved = track, backgroundDownloads) {
  let listener;
  const messages = [], downloads = [], tabs = [], stored = [];
  const chrome = {
    runtime: { id: "extension", getURL: path => `chrome-extension://extension/${path}`, onMessage: { addListener: f => { listener = f; } }, onConnect: { addListener() {} } },
    tabs: { get: async tabId => { assert.equal(tabId, 42); return { id: 42, url: "https://vk.com/audio" }; },
      sendMessage: async (...args) => { messages.push(args); return { track: approved }; },
      create: async args => { tabs.push(args); }, onRemoved: { addListener() {} } },
    downloads: { download: async args => { downloads.push(args); return 19; } },
    storage: { local: { get: async () => ({ backgroundDownloads }) }, session: { set: async args => { stored.push(args); }, remove: async () => {} } }
  };
  runInNewContext(source, { chrome, crypto: webcrypto, errorText, filename, isVkPage, mediaKind, safeUrl, Date, createBitrateProbe: () => async () => ({ kbps: 128, estimated: true }) });
  async function send(message, origin = sender) {
    let response;
    const result = listener(message, origin, value => { response = value; });
    if (result === true) {
      for (let i = 0; i < 100 && response === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
      assert.notEqual(response, undefined);
    }
    return response;
  }
  return { send, messages, downloads, tabs, stored };
}

test("row download uses originating document and approved track, ignoring supplied URL and tab", async () => {
  const h = harness();
  const result = await h.send({ type: "ROW_DOWNLOAD", id, nonce, tabId: 999, url: "https://attacker.invalid/file" });
  assert.equal(result.ok, true);
  assert.equal(h.messages[0][0], 42);
  assert.equal(h.messages[0][1].type, "CONSUME_ROW_DOWNLOAD");
  assert.equal(h.messages[0][1].nonce, nonce);
  assert.equal(h.messages[0][2].documentId, "origin-document");
  assert.equal(h.downloads.length, 0, "Raw URL must never bypass body verification");
  assert.equal(result.separatePage, true);
  assert.equal(result.background, true);
  assert.equal(h.tabs[0].active, false);
  assert.equal(Object.values(h.stored[0])[0].url, track.url);
  assert.equal(Object.values(h.stored[0])[0].title, track.title);
  assert.equal(Object.values(h.stored[0])[0].kind, "mp3");
});

test("missing click grant and wrong returned identity never start downloads", async () => {
  for (const approved of [null, { ...track, id: "different" }]) {
    const h = harness(approved);
    assert.equal((await h.send({ type: "ROW_DOWNLOAD", id, nonce })).ok, false);
    assert.equal(h.downloads.length + h.tabs.length, 0);
  }
});

test("untrusted origins, other extensions, missing document and arbitrary START_DOWNLOAD are rejected", async () => {
  for (const origin of [{ ...sender, id: "other" }, { ...sender, url: "https://evil.example.org/" }, { ...sender, documentId: undefined }, { ...sender, frameId: -1 }, { id: "extension", url: "chrome-extension://extension/download.html" }]) {
    const h = harness();
    assert.notEqual((await h.send({ type: "ROW_DOWNLOAD", id, nonce }, origin))?.ok, true);
    assert.equal(h.downloads.length + h.tabs.length, 0);
  }
  const h = harness();
  assert.equal(await h.send({ type: "START_DOWNLOAD", id, tabId: 42 }), undefined);
});

test("row HLS click stores a temporary job and opens the existing download page", async () => {
  const h = harness({ ...track, url: "https://cdn.vk.com/audio.m3u8" });
  const result = await h.send({ type: "ROW_DOWNLOAD", id, nonce });
  assert.equal(result.separatePage, true);
  assert.equal(h.downloads.length, 0);
  assert.equal(Object.values(h.stored[0])[0].kind, "hls");
  assert.equal(Object.values(h.stored[0])[0].title, track.title);
  assert.match(h.tabs[0].url, /^chrome-extension:\/\/extension\/download.html\?job=/);
});

test("approved page metadata still cannot request local-network URLs", async () => {
  const h = harness({ ...track, url: "https://127.0.0.1/song.mp3" });
  assert.equal((await h.send({ type: "ROW_DOWNLOAD", id, nonce })).ok, false);
  assert.equal(h.downloads.length + h.tabs.length, 0);
});

test("popup direct files use the same verified download page as inline controls", async () => {
  const h = harness(track, false);
  const result = await h.send({ type: "START_DOWNLOAD", id, tabId: 42 }, { id: "extension", url: "chrome-extension://extension/popup.html" });
  assert.equal(result.separatePage, true);
  assert.equal(result.background, false);
  assert.equal(h.tabs[0].active, true);
  assert.equal(h.downloads.length, 0);
  assert.equal(Object.values(h.stored[0])[0].url, track.url);
});

test("bitrate lookup uses approved track in exact document and ignores supplied URL", async () => {
  const h = harness();
  const result = await h.send({ type: "GET_BITRATE", id, url: "https://attacker.example.org/secret", tabId: 900 });
  assert.equal(result.ok, true);
  assert.equal(result.url, track.url);
  assert.equal(h.messages[0][0], 42);
  assert.equal(h.messages[0][2].documentId, "origin-document");
  assert.equal(h.tabs.length + h.downloads.length, 0);
  assert.equal(await h.send({ type: "GET_BITRATE", id }, { ...sender, id: "other" }), undefined);
  assert.equal((await h.send({ type: "GET_BITRATE", id }, { ...sender, documentId: undefined })).ok, false);
});
