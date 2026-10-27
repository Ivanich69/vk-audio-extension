import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const id = "-76_700";
const audio = { id: 700, owner_id: -76, artist: "Artist", title: "Fresh", duration: 1, url: "https://vd546.okcdn.ru/fresh.mp3" };
function harness({ fetchImpl, api, rows = [] } = {}) {
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    location: { href: "https://vk.com/audio" }, document: { querySelectorAll: () => rows.map(value => ({ getAttribute: () => JSON.stringify(value) })) },
    fetch: fetchImpl || (() => { throw new Error("Unexpected fetch"); }), vk: { id: 123 }, vkApi: api });
  context.window = context;
  for (const file of ["api-parser.js", "page-resolver.js"]) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context);
  return { context, resolver: vm.runInContext('window[Symbol.for("vk-audio.resolver.v1")]', context),
    parser: vm.runInContext('window[Symbol.for("vk-audio.parser.v3")]', context) };
}

test("refreshes a captured track using reload_audio without playback or exposing hashes", async () => {
  const requests = [];
  const h = harness({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(`<!--${JSON.stringify({ payload: [0, [[audio]]] })}`);
  } });
  const raw = [700, -76, "", "Fresh", "Artist", 1]; raw[13] = "//action-secret///url-secret";
  h.parser.extract([raw], false, 0, h.resolver.remember);
  const [first, second] = await Promise.all([h.resolver.refresh(id), h.resolver.refresh(id)]);
  assert.equal(first.url, audio.url); assert.equal(second.url, audio.url);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/al_audio.php");
  const params = new URLSearchParams(requests[0].options.body);
  assert.equal(params.get("ids"), "-76_700_action-secret_url-secret");
  assert.equal(params.get("act"), "reload_audio");
  assert.equal(JSON.stringify(first).includes("secret"), false);
  await h.resolver.refresh(id); assert.equal(requests.length, 1);
});

test("resolves missing URL from row metadata, and rejects mismatched track identity", async () => {
  const raw = [700, -76, "", "Fresh", "Artist", 1]; raw[13] = "//action///url";
  for (const returned of [audio, { ...audio, id: 701 }]) {
    const h = harness({ rows: [raw], fetchImpl: async () => new Response(JSON.stringify([returned])) });
    assert.equal((await h.resolver.refresh(id))?.audioId || null, returned.id === 700 ? id : null);
  }
});

test("uses available VK metadata API without reading tokens or invoking the player", async () => {
  let calls = 0;
  const h = harness({ api: { async api(method, params) {
    calls++; assert.equal(method, "audio.getById"); assert.equal(params.audios, "-76_700_access-secret");
    return [audio];
  } } });
  h.resolver.remember({ ...audio, access_key: "access-secret" }, audio);
  assert.equal((await h.resolver.refresh(id)).url, audio.url);
  assert.equal(calls, 1);
});

test("invalid IDs and non-VK origins cannot request metadata; unavailable APIs return null", async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => { calls++; return new Response(null, { status: 403 }); } });
  for (const bad of ["https://evil.org", "-76_700&act=delete", "x", null]) assert.equal(await h.resolver.refresh(bad), null);
  assert.equal(calls, 0);
  assert.equal(await h.resolver.refresh(id), null);
  assert.equal(calls, 1);
  h.context.location.href = "https://vk.com.evil.org/";
  assert.equal(await h.resolver.refresh("-76_701"), null);
  assert.equal(calls, 1);
});

test("visible-row metadata requests queue with two active requests and deduplicate IDs", async () => {
  let active = 0, maximum = 0, calls = 0;
  const h = harness({ fetchImpl: async (url, options) => {
    active++; calls++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    const trackId = Number(new URLSearchParams(options.body).get("ids").split("_")[1]);
    return new Response(JSON.stringify([{ ...audio, id: trackId }]));
  } });
  const results = await Promise.all([...Array.from({ length: 8 }, (_, i) => h.resolver.refresh(`-76_${700 + i}`)), h.resolver.refresh(id)]);
  assert.equal(maximum, 2);
  assert.equal(calls, 8);
  assert.ok(results.every(track => track?.url === audio.url));
});
