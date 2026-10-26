// Isolated headless browser fixture. Never uses an existing profile or a VK account.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, randomUUID } from "node:crypto";
import { maskedUrl } from "../tests/encoded-fixtures.mjs";
import { withEmptyTsPackets } from "../tests/ts-padding-fixtures.mjs";
import { id3Tag, mp3Transport } from "../tests/ts-metadata-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = process.env.VK_TEST_BROWSER || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const withDevtools = process.env.VK_TEST_DEVTOOLS === "1";
const profile = resolve(root, ".browser-test", `profile-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const fixtureDir = resolve(profile, "fixtures");
const downloadDir = resolve(profile, "downloads");
mkdirSync(fixtureDir); mkdirSync(downloadDir);
const ffmpeg = process.env.VK_TEST_FFMPEG || "C:\\ffmpeg\\bin\\ffmpeg.exe";
for (const output of [
  ["-c:a", "libmp3lame", resolve(fixtureDir, "song.mp3")],
  ["-c:a", "aac", "-f", "hls", "-hls_time", "0.5", "-hls_list_size", "0", "-hls_segment_filename", resolve(fixtureDir, "part%d.ts"), resolve(fixtureDir, "list.m3u8")],
  ["-c:a", "libmp3lame", "-f", "hls", "-hls_time", "0.5", "-hls_list_size", "0", "-hls_segment_filename", resolve(fixtureDir, "mp3-part%d.ts"), resolve(fixtureDir, "mp3.m3u8")]
]) {
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", ...output], { windowsHide: true, encoding: "utf8" });
  if (generated.status !== 0) throw new Error(`Generating local audio fixture failed: ${generated.stderr || generated.error}`);
}
const clearPlaylist = readFileSync(resolve(fixtureDir, "list.m3u8"), "utf8");
const clearParts = clearPlaylist.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(name => readFileSync(resolve(fixtureDir, name)));
const references = {};
for (const [name, format, options] of [["list", "adts", []], ["mp3", "mp3", ["-write_xing", "0", "-id3v2_version", "0", "-write_id3v1", "0"]]]) {
  const out = resolve(fixtureDir, `${name}.reference`);
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", resolve(fixtureDir, `${name}.m3u8`), "-map", "0:a:0", "-c:a", "copy", "-f", format, ...options, out], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  references[name] = readFileSync(out);
}
// Reproduce the empty-transport-packet failure in both plain and AES-128 HLS.
// Compare against the original, unmodified audio using an independent demuxer.
for (const [name, format, options] of [["list", "adts", []], ["mp3", "mp3", ["-write_xing", "0", "-id3v2_version", "0", "-write_id3v1", "0"]]]) {
  const shifts = new Map();
  const names = readFileSync(resolve(fixtureDir, `${name}.m3u8`), "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  for (let i = 0; i < names.length; i++) {
    const path = resolve(fixtureDir, names[i]);
    const padded = withEmptyTsPackets(readFileSync(path), shifts);
    writeFileSync(path, padded);
    if (name === "list") clearParts[i] = padded;
  }
  const out = resolve(fixtureDir, `${name}.padded-reference`);
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", resolve(fixtureDir, `${name}.m3u8`), "-map", "0:a:0", "-c:a", "copy", "-f", format, ...options, out], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(readFileSync(out), references[name], "Empty TS packets must preserve the original audio in FFmpeg too");
}
writeFileSync(resolve(fixtureDir, "damaged.ts"), clearParts[0].subarray(0, -1));
writeFileSync(resolve(fixtureDir, "damaged.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\ndamaged.ts\n#EXT-X-ENDLIST\n");
const taggedAudio = Buffer.concat([id3Tag(4, true), references.mp3]);
const unknownTransport = mp3Transport(Buffer.concat([Buffer.from("private-fixture-token"), references.mp3]));
for (const [name, bytes] of [["tagged", mp3Transport(taggedAudio)], ["unknown-header", unknownTransport]]) {
  writeFileSync(resolve(fixtureDir, `${name}.ts`), bytes);
  writeFileSync(resolve(fixtureDir, `${name}.m3u8`), `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2,\n${name}.ts\n#EXT-X-ENDLIST\n`);
}
writeFileSync(resolve(fixtureDir, "incomplete.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2,\nunknown-header.ts\n#EXTINF:2,\nmissing-segment.ts\n#EXT-X-ENDLIST\n");
let unknownSegmentReads = 0;
assert.ok(clearParts.length >= 4, "Need several segments to exercise key rotation and NONE");
const encryptionKeys = [Buffer.alloc(16, 0x31), Buffer.alloc(16, 0x73)];
const encryptedLines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:37"];
for (let i = 0; i < clearParts.length; i++) {
  const plain = i === clearParts.length - 1;
  if (i === 0) encryptedLines.push('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.vk.com/fixture/rotating.key"');
  if (i === 2) encryptedLines.push('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.vk.com/fixture/rotating.key",IV=0xCAFE');
  if (plain) encryptedLines.push('#EXT-X-KEY:METHOD=NONE');
  const iv = Buffer.alloc(16); iv.writeBigUInt64BE(i < 2 ? BigInt(37 + i) : 0xcafen, 8);
  const cipher = createCipheriv("aes-128-cbc", encryptionKeys[i < 2 ? 0 : 1], iv);
  const bytes = plain ? clearParts[i] : Buffer.concat([cipher.update(clearParts[i]), cipher.final()]);
  writeFileSync(resolve(fixtureDir, `encrypted-part${i}.ts`), bytes);
  encryptedLines.push("#EXTINF:0.5,", `encrypted-part${i}.ts`);
}
encryptedLines.push("#EXT-X-ENDLIST");
const encryptedPlaylist = encryptedLines.join("\n");
writeFileSync(resolve(fixtureDir, "encrypted.m3u8"), encryptedPlaylist);
writeFileSync(resolve(fixtureDir, "denied-key.m3u8"), encryptedPlaylist.replaceAll("rotating.key", "missing.key"));
writeFileSync(resolve(fixtureDir, "permission-key.m3u8"), encryptedPlaylist.replaceAll("keys.vk.com", "keys.example.org"));
writeFileSync(resolve(fixtureDir, "bitrate.mp3"), readFileSync(resolve(root, "tests/fixtures/ts/mp3.audio")));
writeFileSync(resolve(fixtureDir, "bitrate-low.mp3"), readFileSync(resolve(root, "tests/fixtures/ts/mp3-low.audio")));
writeFileSync(resolve(fixtureDir, "bitrate-aes.m3u8"), encryptedPlaylist.replaceAll("https://keys.vk.com/fixture/rotating.key", "https://keys.vkuseraudio.ru/bitrate/probe.key"));
writeFileSync(resolve(fixtureDir, "probe.key"), encryptionKeys[0]);
const child = spawn(browser, [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging", "--no-sandbox",
  ...(withDevtools ? ["--auto-open-devtools-for-tabs"] : []),
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "about:blank"
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const socket = { send: text => child.stdio[3].write(text + "\0"), close: () => child.stdio[3].end() };
let nextId = 1;
const pending = new Map();
const listeners = new Map();
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function on(method, callback) {
  const callbacks = listeners.get(method) || [];
  callbacks.push(callback); listeners.set(method, callbacks);
}
async function evaluate(sessionId, expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).catch(error => { throw new Error(`${error.message}: ${expression.slice(0, 130)}`); });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(callback, label) {
  for (let i = 0; i < 100; i++) {
    const value = await callback();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}. ${stderr}`);
}
let browserErrors = [];
let pipeBuffer = "";
child.stdio[4].setEncoding("utf8");
child.stdio[4].on("data", chunk => {
  pipeBuffer += chunk;
  let end;
  while ((end = pipeBuffer.indexOf("\0")) >= 0) {
    const raw = pipeBuffer.slice(0, end); pipeBuffer = pipeBuffer.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timeout); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    } else {
      for (const callback of listeners.get(message.method) || []) Promise.resolve(callback(message.params, message.sessionId)).catch(error => browserErrors.push(error.message));
    }
  }
});
try {
  child.on("error", error => { stderr += error.message; });
  const version = await call("Browser.getVersion");
  console.log(`Isolated browser: ${version.product}`);
  await call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  const installed = await call("Extensions.loadUnpacked", { path: root });
  console.log(`Loaded isolated extension: ${installed.id}`);
  const worker = await until(async () => (await call("Target.getTargets")).targetInfos.find(target => target.type === "service_worker" && target.url.endsWith("/background.js")), "extension worker");
  const extensionId = new URL(worker.url).hostname;
  console.log("Extension worker discovered");
  const { targetId: helperTarget } = await call("Target.createTarget", { url: `chrome-extension://${extensionId}/download.html` });
  const { sessionId: workerSession } = await call("Target.attachToTarget", { targetId: helperTarget, flatten: true });
  await call("Runtime.enable", {}, workerSession);
  on("Runtime.exceptionThrown", params => { browserErrors.push(params.exceptionDetails.text); });

  const fixture = `<!doctype html><html><head><title>Local VK fixture</title></head><body>
    <div class="audio_row" data-audio='[1,2,"https://vk.com/fixture/song.mp3?token=fixture"]'>
      <span class="audio_row__performers">Тестовый артист</span><span class="audio_row__title_inner">Тестовая песня</span>
      <audio preload="none" src="https://vk.com/fixture/song.mp3?token=fixture"></audio>
    </div></body></html>`;
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId: pageSession } = await call("Target.attachToTarget", { targetId, flatten: true });
  await call("Runtime.enable", {}, pageSession);
  await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, pageSession);
  let apiRevision = 0;
  let keyReads = 0;
  let encryptedSegmentReads = 0;
  const verificationRequests = [];
  const bitrateRequests = [];
  on("Fetch.requestPaused", async (params, session) => {
    const url = params.request.url;
    if (new URL(url).pathname.startsWith("/bitrate/")) bitrateRequests.push(url);
    let body;
    let mime;
    let disposition;
    if (/\/encrypted-part\d+\.ts$/.test(new URL(url).pathname)) encryptedSegmentReads++;
    if (url === "https://vk.com/fixture") { body = Buffer.from(fixture); mime = "text/html; charset=utf-8"; }
    else if (url.startsWith("https://web.api.vk.ru/method/messages.getHistory")) {
      const fromFrame = url.includes("unhooked=1");
      body = Buffer.from(JSON.stringify({ response: { items: [{
        text: "private-message-text",
        attachments: [{ type: "audio", audio: {
          id: fromFrame ? 428856954 : 428856953, owner_id: -43260601,
          artist: "Breezey Montana feat. Yanix", title: fromFrame ? "Аудиовложение из iframe" : "Wow [Prod. By SK1ttless Beats]",
          duration: 198, url: `https://vk.com/fixture/song.mp3?siren=1&attachment=${fromFrame ? 2 : 1}`,
          access_key: "not-forwarded", track_code: "not-forwarded"
        } }]
      }] } }).replaceAll("/", "\\/"));
      mime = "application/json";
    }
    else if (url.startsWith("https://vk.com/al_audio.php") && url.includes("encoded=1")) {
      const unhooked = url.includes("unhooked=1");
      const hls = unhooked ? "https://vk.com/fixture/list.m3u8?iframe=1" : "https://vk.com/fixture/list.m3u8";
      const mp3 = `https://vk.com/fixture/song.mp3?music=${unhooked ? 2 : 1}`;
      body = Buffer.from(`<!--${JSON.stringify({ payload: [0, [[
        [unhooked ? 302 : 300, -76, maskedUrl(hls, [["i", 173]], 123456), "Музыка HLS", "Артист каталога", 198],
        [unhooked ? 303 : 301, -76, maskedUrl(mp3, [["v"], ["s", 42]]), "Музыка MP3", "Артист каталога", 210]
      ]]] })}`);
      mime = "text/plain; charset=utf-8";
    }
    else if (url.startsWith("https://vk.com/al_audio.php")) {
      body = Buffer.from(JSON.stringify({ payload: [0, [[
        [200, -76, "", "Нет ссылки", "Артист", 198],
        [201, -76, "https://vk.com/audio_api_unavailable.mp3?extra=private-value", "Скрытая ссылка", "Артист", 198],
        [202, -76, "invalid-private-value", "Неподходящая ссылка", "Артист", 198]
      ]]] }));
      mime = "application/json";
    }
    else if (url.startsWith("https://web.api.vk.ru/method/catalog.getSection")) {
      apiRevision++;
      const audios = [
        { id: 98, owner_id: -76, artist: "Исполнитель API", title: "Точное название", duration: 198, url: "https://vk.com/fixture/song.mp3?token=fixture", access_key: "not-forwarded" },
        { id: 99, owner_id: -76, artist: "Артист API", title: "Трек без расширения", duration: 198, url: `https://vk.com/fixture/opaque?sig=${apiRevision}`, track_code: "not-forwarded" }
      ];
      if (url.includes("unhooked=1")) audios.push({ id: 100, owner_id: -76, artist: "Другой контекст", title: "Ответ из iframe", duration: 12, url: "https://vk.com/fixture/iframe-song.mp3" });
      body = Buffer.from(JSON.stringify({ response: { catalog: { sections: [{ blocks: [{ audios }] }] } } }));
      mime = "application/json";
    }
    else if (url === "https://keys.vk.com/fixture/rotating.key") {
      body = encryptionKeys[Math.min(keyReads++, 1)]; mime = "application/octet-stream";
    }
    else if (/\/(html-as-mp3|json-as-mp3|valid-as-html|once|hls-as-mp3)\.mp3$/.test(new URL(url).pathname)) {
      const name = basename(new URL(url).pathname);
      verificationRequests.push({ name, method: params.request.method });
      const count = verificationRequests.filter(item => item.name === name).length;
      if (name === "html-as-mp3.mp3" || (name === "once.mp3" && count > 1)) {
        body = Buffer.from('<!DOCTYPE html><html>Access denied private-fixture-token</html>'); mime = "audio/mpeg";
      } else if (name === "json-as-mp3.mp3") {
        body = Buffer.from('{"error":"private-fixture-token"}'); mime = "audio/mpeg";
      } else if (name === "hls-as-mp3.mp3") {
        body = Buffer.from(clearPlaylist); mime = "audio/mpeg";
      } else {
        body = readFileSync(resolve(fixtureDir, "song.mp3")); mime = name === "valid-as-html.mp3" ? "text/html" : "audio/mpeg";
        disposition = 'attachment; filename="incorrect.htm"';
      }
    }
    else {
      const name = basename(new URL(url).pathname);
      if (name === "unknown-header.ts") unknownSegmentReads++;
      try { body = readFileSync(resolve(fixtureDir, name === "opaque" ? "list.m3u8" : /^bb[123]\.mp3$/.test(name) ? "song.mp3" : name)); } catch { body = Buffer.alloc(0); }
      mime = name === "opaque" || name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : name.endsWith(".ts") ? "video/mp2t" : "audio/mpeg";
    }
    await call("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: body.length ? 200 : 404,
      responseHeaders: [{ name: "Content-Type", value: mime }, { name: "Access-Control-Allow-Origin", value: "https://vk.com" }, { name: "Access-Control-Allow-Credentials", value: "true" }, ...(disposition ? [{ name: "Content-Disposition", value: disposition }] : [])],
      body: body.toString("base64")
    }, session);
  });
  await call("Page.navigate", { url: "https://vk.com/fixture" }, pageSession);
  const tabId = await until(async () => evaluate(workerSession, `(async () => (await chrome.tabs.query({})).find(t => t.url === 'https://vk.com/fixture')?.id)()`), "fixture tab");
  const trackList = await until(async () => {
    try { return await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId}, {type:'LIST_TRACKS'}, {frameId:0})`); }
    catch { return null; }
  }, "content script");
  assert.equal(trackList.tracks.length, 1);
  assert.equal(trackList.tracks[0].title, "Тестовый артист — Тестовая песня");
  assert.equal(trackList.tracks[0].kind, "mp3");
  assert.equal(trackList.diagnostics.contentVersion, "0.3.13");
  assert.equal(await evaluate(pageSession, "Boolean(window[Symbol.for('vk-audio.capture.v3')])"), true);
  await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    return list.diagnostics.main?.version === "0.3.13";
  }, "page capture handshake");
  await evaluate(pageSession, "fetch('https://vk.com/fixture/bb2.mp3').then(r=>r.arrayBuffer())");
  await evaluate(pageSession, "fetch('https://vk.com/fixture/list.m3u8').then(r=>r.text())");
  const withHls = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'}, {frameId:0})`);
    return list.tracks.some(track => track.kind === "hls") ? list : null;
  }, "resource timing HLS discovery");
  assert.equal(withHls.tracks.length, 2);
  assert.equal(withHls.diagnostics.suppressedSounds, 1);

  const { targetId: popupTarget } = await call("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId: popupSession } = await call("Target.attachToTarget", { targetId: popupTarget, flatten: true });
  await call("Runtime.enable", {}, popupSession);
  await until(async () => evaluate(popupSession, "Boolean(document.getElementById('refresh'))"), "popup HTML");
  await until(async () => evaluate(popupSession, "!document.getElementById('auto-close-downloads').disabled"), "auto-close settings loaded");
  assert.equal(await evaluate(popupSession, "document.getElementById('auto-close-downloads').checked"), true);
  // Keep completed pages available for the existing format and retry checks.
  await evaluate(popupSession, "document.getElementById('auto-close-downloads').click()");
  await until(async () => evaluate(workerSession, "chrome.storage.local.get('autoCloseDownloads').then(s=>s.autoCloseDownloads === false)"), "auto-close disabled for inspection");
  // The test opens the popup as an extension page, then selects the fixture tab.
  await evaluate(workerSession, `chrome.tabs.update(${tabId}, {active:true})`);
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "document.querySelectorAll('#tracks li').length === 2"), "popup source list");
  assert.equal(await evaluate(popupSession, "document.getElementById('status').textContent"), "");

  // Reproduce the report: API metadata has no usable URL, but HLS is detected.
  await evaluate(pageSession, "fetch('/al_audio.php?act=reload_audios').then(r=>r.json())");
  const missing = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    return list.diagnostics.main?.missingUrls === 3 ? list : null;
  }, "categorized missing URL diagnostics");
  for (const key of ["emptyUrls", "encodedUrls", "invalidUrls"]) assert.equal(missing.diagnostics.main[key], 1);
  assert.equal(missing.diagnostics.apiTracks, 0);
  assert.equal(JSON.stringify(missing.diagnostics).includes("private-value"), false);
  await evaluate(pageSession, "navigator.mediaSession.metadata = new MediaMetadata({artist:'Артист плеера',title:'Название потока'})");
  await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    return list.playerTitle === "Артист плеера — Название потока";
  }, "player metadata in content script");
  await evaluate(workerSession, `chrome.tabs.update(${tabId}, {active:true})`);
  await until(async () => evaluate(popupSession, "!document.getElementById('refresh').disabled"), "popup ready for refresh");
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "document.getElementById('player-title').textContent.includes('Артист плеера — Название потока')"), "Media Session metadata shared with isolated content script");
  // A historical stream must not be silently renamed using the current player.
  assert.equal(await evaluate(popupSession, "[...document.querySelectorAll('#tracks li')].find(li=>li.textContent.includes('HLS')).querySelector('strong').textContent"), "list.m3u8");
  await evaluate(popupSession, "[...document.querySelectorAll('#tracks li')].find(li=>li.textContent.includes('HLS')).querySelector('.name-from-player').click()");
  await until(async () => evaluate(popupSession, "[...document.querySelectorAll('#tracks li')].find(li=>li.textContent.includes('HLS')).querySelector('strong').textContent === 'Артист плеера — Название потока'"), "user selects player title for discovered HLS");
  await evaluate(pageSession, "navigator.mediaSession.metadata = new MediaMetadata({artist:'Следующий артист',title:'Другая песня'})");
  const staleName = await evaluate(popupSession, `chrome.tabs.sendMessage(${tabId}, {type:'NAME_FROM_PLAYER', id:${JSON.stringify(withHls.tracks.find(track => track.kind === "hls").id)}, expectedTitle:'Артист плеера — Название потока'}, {frameId:0})`);
  assert.equal(staleName.ok, false);
  const stillNamed = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
  assert.equal(stillNamed.tracks.find(track => track.kind === "hls").title, "Артист плеера — Название потока");
  await evaluate(pageSession, "navigator.mediaSession.metadata = null");
  await evaluate(popupSession, "document.getElementById('refresh').click()");

  // Match the screenshot: named audio objects nested in a catalog.getSection response.
  await evaluate(pageSession, "fetch(new Request('https://web.api.vk.ru/method/catalog.getSection?v=5.289')).then(r=>r.json())");
  const apiTracks = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'}, {frameId:0})`);
    return list.tracks.filter(track => track.source === "vk-api").length === 2 ? list.tracks : null;
  }, "catalog metadata from page fetch");
  assert.equal(apiTracks.length, 3);
  const named = apiTracks.find(track => track.audioId === "-76_98");
  const opaque = apiTracks.find(track => track.audioId === "-76_99");
  assert.equal(named.title, "Исполнитель API — Точное название");
  assert.equal(opaque.title, "Артист API — Трек без расширения");
  assert.equal(opaque.duration, 198);
  assert.equal(opaque.kind, "audio");
  assert.equal(JSON.stringify(apiTracks).includes("not-forwarded"), false);
  await evaluate(pageSession, "new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','https://web.api.vk.ru/method/catalog.getSection?v=5.289');xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=reject;xhr.send();})");
  const updated = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'}, {frameId:0})`);
    const track = list.tracks.find(track => track.audioId === "-76_99");
    return track?.url.endsWith("sig=2") ? list.tracks : null;
  }, "XHR refresh of signed API URLs");
  assert.equal(updated.length, 3);
  assert.equal(updated.find(track => track.audioId === "-76_99").id, opaque.id);
  assert.equal(updated.find(track => track.audioId === "-76_98").title, named.title);
  await evaluate(workerSession, `chrome.tabs.update(${tabId}, {active:true})`);
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "document.querySelectorAll('#tracks li').length === 3"), "named API tracks in popup");
  assert.equal(await evaluate(popupSession, "document.getElementById('tracks').textContent.includes('Артист API — Трек без расширения') && document.getElementById('tracks').textContent.includes('3:18')"), true);
  await evaluate(pageSession, "window.fetch=window.fetch.bind(window)");
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "JSON.parse(document.getElementById('diagnostics').value).main?.fetchHook === true"), "repair of replaced page fetch hook");

  // The user's actual endpoint: audio attachment in message history, not catalog.
  await evaluate(pageSession, "fetch('https://web.api.vk.ru/method/messages.getHistory?v=5.289&client_id=6287487').then(r=>r.json())");
  const historyTrack = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    assert.equal(JSON.stringify(list).includes("private-message-text"), false);
    assert.equal(JSON.stringify(list).includes("not-forwarded"), false);
    return list.tracks.find(track => track.audioId === "-43260601_428856953");
  }, "messages.getHistory audio attachment");
  assert.equal(historyTrack.title, "Breezey Montana feat. Yanix — Wow [Prod. By SK1ttless Beats]");
  assert.equal(historyTrack.kind, "mp3");
  assert.equal(historyTrack.duration, 198);
  assert.equal(historyTrack.url, "https://vk.com/fixture/song.mp3?siren=1&attachment=1");
  await evaluate(workerSession, `chrome.tabs.update(${tabId}, {active:true})`);
  await until(async () => evaluate(popupSession, "!document.getElementById('refresh').disabled"), "popup ready for history refresh");
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "[...document.querySelectorAll('#tracks li')].some(li=>li.textContent.includes('Wow [Prod. By SK1ttless Beats]') && li.textContent.includes('MP3') && li.textContent.includes('3:18'))"), "history attachment name, duration and MP3 in popup");

  await evaluate(pageSession, "window.vk={id:123456}; fetch('/al_audio.php?act=reload_audios&encoded=1').then(r=>r.text())");
  const music = await until(async () => {
    const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    return list.tracks.some(track=>track.audioId==='-76_300') && list.tracks.some(track=>track.audioId==='-76_301') ? list : null;
  }, "encoded Music tab sources");
  const musicHls = music.tracks.find(track=>track.audioId==='-76_300');
  assert.equal(musicHls.id, withHls.tracks.find(track=>track.kind==='hls').id);
  assert.equal(musicHls.title, "Артист каталога — Музыка HLS");
  assert.equal(musicHls.kind, "hls");
  assert.equal(music.tracks.find(track=>track.audioId==='-76_301').kind, "mp3");
  assert.equal(music.diagnostics.main.decodedUrls, 2);
  assert.equal(JSON.stringify(music.diagnostics).includes("123456"), false);
  assert.equal(music.tracks.some(track=>track.url.includes("audio_api_unavailable")), false);
  await evaluate(workerSession, `chrome.tabs.update(${tabId}, {active:true})`);
  await until(async () => evaluate(popupSession, "!document.getElementById('refresh').disabled"), "popup ready for music refresh");
  await evaluate(popupSession, "document.getElementById('refresh').click()");
  await until(async () => evaluate(popupSession, "document.getElementById('tracks').textContent.includes('Артист каталога — Музыка HLS') && document.getElementById('tracks').textContent.includes('Артист каталога — Музыка MP3')"), "named music links in popup");

  if (withDevtools) {
    console.log("Checking real DevTools capture");
    await until(async () => {
      const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
      return list.diagnostics.devtools?.active;
    }, "real DevTools extension page");
    console.log("DevTools extension page is active");
    const before = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
    // An about:blank iframe has fresh native fetch/Response objects and no content
    // scripts in this manifest. Only the DevTools API can supply its response here.
    await evaluate(pageSession, "(async()=>{const frame=document.createElement('iframe');document.body.append(frame);await frame.contentWindow.fetch('https://web.api.vk.ru/method/messages.getHistory?unhooked=1').then(r=>r.json());return 'done'})()");
    const captured = await until(async () => {
      const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
      return list.tracks.some(track=>track.audioId==='-43260601_428856954') ? list : null;
    }, "DevTools capture of unhooked message history response");
    assert.equal(captured.tracks.find(track=>track.audioId==='-43260601_428856954').title, "Breezey Montana feat. Yanix — Аудиовложение из iframe");
    assert.equal(captured.diagnostics.main.found, before.diagnostics.main.found);
    await evaluate(pageSession, "(async()=>{const frame=document.createElement('iframe');document.body.append(frame);await frame.contentWindow.fetch('https://vk.com/al_audio.php?encoded=1&unhooked=1').then(r=>r.text());return 'done'})()");
    const decoded = await until(async () => {
      const list = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
      return list.tracks.some(track=>track.audioId==='-76_302') ? list : null;
    }, "DevTools decodes viewer-bound Music links using inspectedWindow");
    assert.equal(decoded.tracks.find(track=>track.audioId==='-76_302').url, "https://vk.com/fixture/list.m3u8?iframe=1");
    assert.equal(decoded.diagnostics.main.found, before.diagnostics.main.found);
    assert.ok(decoded.diagnostics.devtools.decodedUrls >= 2);
  }

  // Other extension pages cannot start a background download through messaging.
  const denied = await evaluate(workerSession, `chrome.runtime.sendMessage({type:'START_DOWNLOAD',tabId:${tabId},id:${JSON.stringify(trackList.tracks[0].id)}}).then(response=>response?.ok!==true,()=>true)`);
  assert.equal(denied, true);

  // Run the real HLS page with a temporary in-memory job and intercepted fixture requests.
  const jobId = randomUUID();
  const jobData = { [`job:${jobId}`]: { url: opaque.url, kind: "audio", title: opaque.title, createdAt: Date.now() } };
  await evaluate(workerSession, `chrome.storage.session.set(${JSON.stringify(jobData)})`);
  const { targetId: hlsTarget } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId: hlsSession } = await call("Target.attachToTarget", { targetId: hlsTarget, flatten: true });
  await call("Runtime.enable", {}, hlsSession);
  await call("Fetch.enable", { patterns: [{ urlPattern: "https://vk.com/fixture/*" }] }, hlsSession);
  await call("Page.navigate", { url: `chrome-extension://${extensionId}/download.html?job=${jobId}` }, hlsSession);
  await until(async () => evaluate(hlsSession, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), "HLS file download");
  const hlsDownloads = (await evaluate(workerSession, "chrome.downloads.search({})")).filter(item => item.state === "complete" && item.url.startsWith(`blob:chrome-extension://${extensionId}/`));
  assert.equal(hlsDownloads.length, 1);
  assert.deepEqual(readFileSync(hlsDownloads[0].filename), references.list);
  assert.match(await evaluate(hlsSession, "document.getElementById('format-hint').textContent"), /AAC/);
  const decoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", hlsDownloads[0].filename, "-f", "null", "-"], { windowsHide: true, encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr || String(decoded.error));

  const downloadTargets = new Map();
  async function openEncryptedJob(name, kind = "hls", origin = "https://vk.com") {
    const id = randomUUID();
    await evaluate(workerSession, `chrome.storage.session.set(${JSON.stringify({ [`job:${id}`]: { url: `${origin}/fixture/${name}`, kind, title: "AES-128 fixture", createdAt: Date.now() } })})`);
    const { targetId: target } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId: session } = await call("Target.attachToTarget", { targetId: target, flatten: true });
    downloadTargets.set(session, target);
    await call("Runtime.enable", {}, session);
    await call("Fetch.enable", { patterns: [{ urlPattern: `${origin}/fixture/*` }, { urlPattern: "https://keys.vk.com/fixture/*" }] }, session);
    await call("Page.navigate", { url: `chrome-extension://${extensionId}/download.html?job=${id}` }, session);
    return session;
  }
  const encryptedSession = await openEncryptedJob("encrypted.m3u8");
  await until(async () => evaluate(encryptedSession, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), "AES-128 HLS download with rotated key");
  assert.equal(keyReads, 2, "Same-URI key rotation must reload the key on a new EXT-X-KEY");
  const encryptedDownload = await until(async () => {
    const all = await evaluate(workerSession, "chrome.downloads.search({})");
    return all.find(item=>item.state==='complete' && item.url.startsWith(`blob:chrome-extension://${extensionId}/`) && item.id!==hlsDownloads[0].id);
  }, "encrypted download result");
  assert.deepEqual(readFileSync(encryptedDownload.filename), references.list);
  const encryptedDecoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", encryptedDownload.filename, "-f", "null", "-"], { windowsHide: true, encoding: "utf8" });
  assert.equal(encryptedDecoded.status, 0, encryptedDecoded.stderr);
  const readsBeforeDenial = encryptedSegmentReads;
  const deniedSession = await openEncryptedJob("denied-key.m3u8");
  await until(async () => evaluate(deniedSession, "document.getElementById('status')?.textContent.includes('HTTP 404')"), "unavailable key produces HTTP error");
  assert.equal(encryptedSegmentReads, readsBeforeDenial, "No segments requested with missing key");
  const permissionSession = await openEncryptedJob("permission-key.m3u8");
  await until(async () => evaluate(permissionSession, "document.getElementById('grant') && !document.getElementById('grant').hidden"), "separate key origin requires permission");
  assert.equal(encryptedSegmentReads, readsBeforeDenial, "Permission pause must precede media downloads");
  const completedAfterErrors = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
  assert.equal(completedAfterErrors.length, 2);
  const mp3Session = await openEncryptedJob("mp3.m3u8");
  await until(async () => evaluate(mp3Session, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), "MP3 extracted from HLS TS");
  assert.match(await evaluate(mp3Session, "document.getElementById('format-hint').textContent"), /MP3/);
  const mp3Download = (await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).find(item => !completedAfterErrors.some(old => old.id === item.id));
  assert.deepEqual(readFileSync(mp3Download.filename), references.mp3);
  const mp3Decoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", mp3Download.filename, "-f", "null", "-"], { windowsHide: true, encoding: "utf8" });
  assert.equal(mp3Decoded.status, 0, mp3Decoded.stderr);
  const damagedSession = await openEncryptedJob("damaged.m3u8");
  await until(async () => evaluate(damagedSession, "document.getElementById('status')?.textContent.includes('обрезан транспортный пакет')"), "damaged TS fails without saving");
  assert.equal((await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).length, 3);

  // Real page controls: lazy rendering, identity matching, trusted mouse/keyboard
  // events and download-page startup, with all media served by local fixtures.
  await evaluate(pageSession, `(() => {
    const root = document.createElement('section'); root.id = 'row-controls-fixture';
    root.innerHTML = '<div class="audio_row" id="inline-hls" data-full-id="-76_300"><span class="audio_row__performers">Одинаковый артист</span> <span class="audio_row__title">Одинаковое название</span><span class="audio_row__actions"></span></div><div class="audio_row" id="inline-mp3" data-full-id="-76_301"><span class="audio_row__performers">Одинаковый артист</span> <span class="audio_row__title">Одинаковое название</span><span class="audio_row__actions"></span></div><div class="audio_row" id="inline-missing" data-full-id="-76_999"><span class="audio_row__title">Нет ссылки</span><span class="audio_row__actions"></span></div>';
    document.body.append(root);
    window.rowPlayEvents = 0;
    for (const row of root.children) row.addEventListener('click', () => window.rowPlayEvents++);
  })()`);
  const rowButton = id => `document.querySelector('#${id} [data-vk-audio-download]')?.shadowRoot.querySelector('button')`;
  await until(async () => evaluate(pageSession, `Boolean(${rowButton("inline-hls")}) && !(${rowButton("inline-hls")}).disabled`), "inline HLS button after lazy row insertion");
  assert.match(await evaluate(pageSession, `(${rowButton("inline-hls")}).getAttribute('aria-label')`), /Музыка HLS/);
  assert.match(await evaluate(pageSession, `(${rowButton("inline-mp3")}).getAttribute('aria-label')`), /Музыка MP3/);
  assert.equal(await evaluate(pageSession, `(${rowButton("inline-missing")}).disabled`), true);
  await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'IMPORT_TRACKS',tracks:[{audioId:'-76_999',artist:'Поздний ответ',name:'Ссылка появилась',duration:2,url:'https://vk.com/fixture/list.m3u8?late=1'}]},{frameId:0})`);
  await until(async () => evaluate(pageSession, `!(${rowButton("inline-missing")}).disabled`), "row enables when metadata arrives after rendering");
  const tabsBeforeSynthetic = new Set((await call("Target.getTargets")).targetInfos.map(t => t.targetId));
  await evaluate(pageSession, `(${rowButton("inline-hls")}).click()`);
  await sleep(200);
  assert.equal((await call("Target.getTargets")).targetInfos.some(t => t.url.startsWith(`chrome-extension://${extensionId}/download.html`) && !tabsBeforeSynthetic.has(t.targetId)), false);
  assert.equal((await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).length, 3);
  assert.equal(await evaluate(pageSession, "window.rowPlayEvents"), 0);
  const rowTrackList = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'LIST_TRACKS'},{frameId:0})`);
  const rowHlsTrack = rowTrackList.tracks.find(track => track.audioId === "-76_300");
  const deniedRow = await evaluate(workerSession, `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:async()=>chrome.runtime.sendMessage({type:'ROW_DOWNLOAD',id:${JSON.stringify(rowHlsTrack.id)},nonce:'12345678-1234-4234-8234-123456789abc'})})`);
  assert.equal(deniedRow[0].result.ok, false);

  // Recycled row identity must immediately invalidate the old track binding.
  await evaluate(pageSession, "document.getElementById('inline-hls').setAttribute('data-full-id','-76_998')");
  await until(async () => evaluate(pageSession, `(${rowButton("inline-hls")}).disabled`), "recycled row disables stale URL");
  await evaluate(pageSession, "document.getElementById('inline-hls').setAttribute('data-full-id','-76_300'); document.querySelector('#inline-hls .audio_row__actions').replaceChildren()");
  await until(async () => evaluate(pageSession, `Boolean(${rowButton("inline-hls")}) && !(${rowButton("inline-hls")}).disabled`), "removed control restored after VK rerender");
  assert.equal(await evaluate(pageSession, "document.querySelectorAll('#inline-hls [data-vk-audio-download]').length"), 1);

  const existingTargets = new Set((await call("Target.getTargets")).targetInfos.map(t => t.targetId));
  const rowPages = new Map();
  on("Target.attachedToTarget", async params => {
    if (params.targetInfo.type === "page" && !existingTargets.has(params.targetInfo.targetId)) {
      await call("Runtime.enable", {}, params.sessionId);
      await call("Fetch.enable", { patterns: [{ urlPattern: "https://vk.com/fixture/*" }] }, params.sessionId);
      rowPages.set(params.targetInfo.targetId, params.sessionId);
    }
    await call("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
  });
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }, { exclude: true }] });
  for (const mode of ["mouse", "keyboard", "direct"]) {
    await until(async () => evaluate(popupSession, "!document.getElementById('background-downloads').disabled"), "settings loaded");
    if (mode === "direct") {
      await evaluate(popupSession, "document.getElementById('background-downloads').click()");
      await until(async () => evaluate(workerSession, "chrome.storage.local.get('backgroundDownloads').then(s=>s.backgroundDownloads === false)"), "foreground preference saved");
      await evaluate(popupSession, "location.reload()");
      await until(async () => evaluate(popupSession, "document.getElementById('background-downloads') && !document.getElementById('background-downloads').disabled && !document.getElementById('background-downloads').checked"), "setting survives reopening popup");
      assert.equal(await evaluate(popupSession, "document.getElementById('auto-close-downloads').checked"), false);
    } else {
      assert.equal(await evaluate(popupSession, "document.getElementById('background-downloads').checked"), true);
    }
    const previousPages = new Set(rowPages.keys());
    const buttonId = mode === "direct" ? "inline-mp3" : "inline-hls";
    await call("Page.bringToFront", {}, pageSession);
    await until(async () => evaluate(pageSession, `!(${rowButton(buttonId)}).disabled`), "row button ready for another download");
    const point = await evaluate(pageSession, `(() => { const b = ${rowButton(buttonId)}; b.scrollIntoView({block:'center'}); b.focus(); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (mode !== "keyboard") {
      assert.equal(await evaluate(pageSession, `document.elementFromPoint(${point.x},${point.y})?.shadowRoot?.querySelector('button') === (${rowButton(buttonId)})`), true, "Row button must not be covered by the status notice or another element");
      await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, pageSession);
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, pageSession);
    } else {
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, pageSession);
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, pageSession);
    }
    const newPage = await until(async () => [...rowPages.entries()].find(([id]) => !previousPages.has(id)), `${mode} click opens download page`);
    await until(async () => evaluate(newPage[1], "document.getElementById('status')?.textContent.includes('Файл сохранён')"), `${mode} row download completes`);
    assert.equal(await evaluate(newPage[1], "document.getElementById('title').textContent"), mode === "direct" ? rowTrackList.tracks.find(track => track.audioId === "-76_301").title : rowHlsTrack.title);
    assert.equal(await evaluate(pageSession, "window.rowPlayEvents"), 0);
    assert.equal(await evaluate(workerSession, `chrome.tabs.get(${tabId}).then(tab=>tab.active)`), mode !== "direct", "background mode must keep VK selected; foreground preference must switch away");
  }
  await evaluate(popupSession, "document.getElementById('background-downloads').click()");
  await until(async () => evaluate(workerSession, "chrome.storage.local.get('backgroundDownloads').then(s=>s.backgroundDownloads === true)"), "background preference restored");
  await call("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  const rowDownloads = (await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).filter(item => ![hlsDownloads[0].id, encryptedDownload.id, mp3Download.id].includes(item.id));
  assert.equal(rowDownloads.length, 3);
  const song = readFileSync(resolve(fixtureDir, "song.mp3"));
  assert.equal(rowDownloads.filter(item => readFileSync(item.filename).equals(references.list)).length, 2);
  assert.equal(rowDownloads.filter(item => readFileSync(item.filename).equals(song)).length, 1);

  // HTTP 200 and an audio MIME cannot turn HTML/JSON into a valid download.
  let completed = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
  for (const name of ["html-as-mp3.mp3", "json-as-mp3.mp3"]) {
    const session = await openEncryptedJob(name, "mp3");
    await until(async () => evaluate(session, "document.getElementById('status')?.textContent.includes('Файл не сохранён')"), `${name} rejected before Save As`);
    assert.equal((await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).length, completed.length);
    assert.equal(await evaluate(session, "document.getElementById('status').textContent.includes('private-fixture-token')"), false);
  }
  for (const name of ["valid-as-html.mp3", "once.mp3", "hls-as-mp3.mp3"]) {
    const session = await openEncryptedJob(name, "mp3");
    await until(async () => evaluate(session, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), `${name} saved from verified bytes`);
    const all = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
    const item = all.find(item => !completed.some(old => old.id === item.id));
    assert.ok(item.url.startsWith(`blob:chrome-extension://${extensionId}/`));
    assert.deepEqual(readFileSync(item.filename), name === "hls-as-mp3.mp3" ? references.list : song);
    if (name !== "hls-as-mp3.mp3") {
      assert.equal(item.mime, "audio/mpeg");
      assert.ok(item.filename.endsWith(".mp3"));
    }
    assert.match(await evaluate(session, "document.getElementById('format-hint').textContent"), name === "hls-as-mp3.mp3" ? /AAC/ : /MP3/);
    completed = all;
  }
  for (const name of ["html-as-mp3.mp3", "json-as-mp3.mp3", "valid-as-html.mp3", "once.mp3", "hls-as-mp3.mp3"]) {
    assert.deepEqual(verificationRequests.filter(item => item.name === name), [{ name, method: "GET" }]);
  }
  // New compatibility path plus explicit recovery after a completed TS fetch.
  const taggedSession = await openEncryptedJob("tagged.m3u8");
  await until(async () => evaluate(taggedSession, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), "tagged MP3 saved");
  const taggedDownloads = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
  const taggedFile = taggedDownloads.find(item => !completed.some(old => old.id === item.id));
  assert.ok(taggedFile.filename.endsWith(".mp3"));
  assert.deepEqual(readFileSync(taggedFile.filename), taggedAudio);
  const taggedDecode = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", taggedFile.filename, "-f", "null", "-"], { windowsHide: true, encoding: "utf8" });
  assert.equal(taggedDecode.status, 0, taggedDecode.stderr);
  assert.equal(await evaluate(taggedSession, "document.getElementById('save-ts').hidden"), true);
  const unknownSession = await openEncryptedJob("unknown-header.m3u8");
  await until(async () => evaluate(unknownSession, "document.getElementById('status')?.textContent.includes('неверный заголовок MPEG Audio')"), "unknown prefix rejected");
  const diagnostics = await evaluate(unknownSession, "JSON.parse(document.getElementById('diagnostic-text').value)");
  assert.equal(diagnostics.stage, "audio-frames");
  assert.equal(diagnostics.offset, 0);
  assert.equal(diagnostics.signature, "unknown");
  assert.equal(diagnostics.downloadedBytes, unknownTransport.length);
  assert.equal(JSON.stringify(diagnostics).includes("private-fixture-token"), false);
  assert.equal((await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).length, taggedDownloads.length, "No automatic save on extraction failure");
  const readsBeforeFallback = unknownSegmentReads;
  // CDP auto-save bypasses native Save As and may replace the suggested name
  // with a Blob UUID. Check the actual download API argument separately.
  await evaluate(unknownSession, "window.saveRequests = []; const nativeDownload = chrome.downloads.download.bind(chrome.downloads); chrome.downloads.download = options => { window.saveRequests.push(options); return nativeDownload(options); }");
  // Exercise repeat saving the retained Blob without another network request.
  let beforeFallback = taggedDownloads;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await evaluate(unknownSession, "document.getElementById('save-ts').hidden"), false);
    await evaluate(unknownSession, "document.getElementById('save-ts').click()");
    await until(async () => evaluate(unknownSession, "!document.getElementById('save-ts').hidden && document.getElementById('status').textContent.includes('Файл сохранён')"), "explicit TS fallback saved");
    const all = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
    const saved = all.find(item => !beforeFallback.some(old => old.id === item.id));
    assert.ok((await evaluate(unknownSession, "window.saveRequests.at(-1).filename")).endsWith(".ts"));
    assert.equal(saved.mime, "video/mp2t");
    assert.deepEqual(readFileSync(saved.filename), unknownTransport);
    assert.equal(unknownSegmentReads, readsBeforeFallback);
    beforeFallback = all;
  }
  const incompleteSession = await openEncryptedJob("incomplete.m3u8");
  await until(async () => evaluate(incompleteSession, "document.getElementById('status')?.textContent.includes('HTTP 404')"), "partial fetch rejected");
  for (const session of [incompleteSession, deniedSession, permissionSession]) {
    assert.equal(await evaluate(session, "document.getElementById('save-ts').hidden"), true);
    assert.equal(await evaluate(session, "document.getElementById('diagnostics').hidden"), true);
  }
  assert.equal((await evaluate(workerSession, "chrome.downloads.search({state:'complete'})")).length, beforeFallback.length);
  // Required CDN host permission must work in a fresh profile, without any
  // permissions.request call or prior grant for these individual servers.
  for (const host of ["vkuseraudio.ru", "cs1-77v4.vkuseraudio.ru", "psv4.vkuseraudio.ru", "keys.vkuseraudio.ru"]) {
    assert.equal(await evaluate(workerSession, `chrome.permissions.contains({origins:[${JSON.stringify(`https://${host}/*`)}]})`), true);
  }
  for (const host of ["vkuseraudio.ru.example.org", "fakevkuseraudio.ru", "audio.example.org"]) {
    assert.equal(await evaluate(workerSession, `chrome.permissions.contains({origins:[${JSON.stringify(`https://${host}/*`)}]})`), false);
  }
  let beforeCdn = beforeFallback;
  for (const [name, kind, origin, expected] of [
    ["mp3.m3u8", "hls", "https://cs1-77v4.vkuseraudio.ru", references.mp3],
    ["song.mp3", "mp3", "https://psv4.vkuseraudio.ru", song]
  ]) {
    const session = await openEncryptedJob(name, kind, origin);
    await until(async () => evaluate(session, "document.getElementById('status')?.textContent.includes('Файл сохранён')"), "CDN download without a permission prompt");
    assert.equal(await evaluate(session, "document.getElementById('grant').hidden"), true);
    const all = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
    const saved = all.find(item => !beforeCdn.some(old => old.id === item.id));
    assert.deepEqual(readFileSync(saved.filename), expected);
    beforeCdn = all;
  }
  // Re-enable through the actual UI and verify real tab removal only after the
  // browser has saved every byte, for direct, HLS and explicit TS recovery.
  await evaluate(popupSession, "document.getElementById('auto-close-downloads').click()");
  await until(async () => evaluate(workerSession, "chrome.storage.local.get('autoCloseDownloads').then(s=>s.autoCloseDownloads === true)"), "auto-close enabled");
  let beforeAutoClose = beforeCdn;
  for (const [name, expected] of [["song.mp3", song], ["mp3.m3u8", references.mp3], ["unknown-header.m3u8", unknownTransport]]) {
    const session = await openEncryptedJob(name);
    if (name === "unknown-header.m3u8") {
      await until(async () => evaluate(session, "document.getElementById('save-ts') && !document.getElementById('save-ts').hidden"), "extraction failure keeps page open");
      await evaluate(session, "document.getElementById('save-ts').click()");
    }
    await until(async () => !(await call("Target.getTargets")).targetInfos.some(t => t.targetId === downloadTargets.get(session)), "successful download tab closes automatically");
    const all = await evaluate(workerSession, "chrome.downloads.search({state:'complete'})");
    assert.equal(all.length, beforeAutoClose.length + 1);
    const saved = all.find(item => !beforeAutoClose.some(old => old.id === item.id));
    assert.deepEqual(readFileSync(saved.filename), expected);
    assert.equal(await evaluate(workerSession, `chrome.tabs.get(${tabId}).then(t=>t.id)`), tabId, "VK tab must remain open");
    beforeAutoClose = all;
  }
  for (const [name, condition] of [
    ["html-as-mp3.mp3", "document.getElementById('status')?.textContent.includes('Файл не сохранён')"],
    ["permission-key.m3u8", "document.getElementById('grant') && !document.getElementById('grant').hidden"]
  ]) {
    const session = await openEncryptedJob(name);
    await until(async () => evaluate(session, condition), "failure or permission request remains visible with auto-close on");
    assert.ok((await call("Target.getTargets")).targetInfos.some(t => t.targetId === downloadTargets.get(session)));
  }
  // Probe traffic comes from the real service worker, never from the page.
  const { sessionId: probeSession } = await call("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  await call("Fetch.enable", { patterns: [{ urlPattern: "https://*.vkuseraudio.ru/bitrate/*" }] }, probeSession);
  const probeTracks = [
    { audioId: "-76_700", artist: "Bitrate", name: "MP3", duration: 1, url: "https://cs1-77v4.vkuseraudio.ru/bitrate/bitrate.mp3" },
    { audioId: "-76_701", artist: "Bitrate", name: "HLS", duration: 2, url: "https://cs1-77v4.vkuseraudio.ru/bitrate/mp3.m3u8" },
    { audioId: "-76_702", artist: "Bitrate", name: "AES", duration: 2, url: "https://cs1-77v4.vkuseraudio.ru/bitrate/bitrate-aes.m3u8" }
  ];
  await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'IMPORT_TRACKS',tracks:${JSON.stringify(probeTracks)}},{frameId:0})`);
  await evaluate(pageSession, `(() => {
    const box = document.createElement('section'); box.id='bitrate-fixture';
    box.style.cssText='position:fixed;top:0;left:0;z-index:99999;background:white;width:500px';
    box.innerHTML=${JSON.stringify(probeTracks.map((t, i) => `<div class="audio_row" id="bitrate-${i}" data-full-id="${t.audioId}"><span class="audio_row__title">Bitrate</span><span class="audio_row__actions"></span></div>`).join(''))};
    document.body.append(box);
  })()`);
  await call("Page.bringToFront", {}, pageSession);
  const bitrateText = i => `document.querySelector('#bitrate-${i} [data-vk-audio-download]')?.shadowRoot.querySelector('.bitrate').textContent`;
  for (let i = 0; i < 3; i++) await until(async () => evaluate(pageSession, `(${bitrateText(i)})?.includes('≈')`), `bitrate label ${i}`);
  assert.equal(await evaluate(pageSession, bitrateText(0)), "≈64 кбит/с");
  assert.equal(await evaluate(pageSession, bitrateText(1)), "≈64 кбит/с");
  const beforePopupProbes = bitrateRequests.length;
  await call("Page.bringToFront", {}, popupSession);
  await evaluate(popupSession, `chrome.tabs.query = async () => [{id:${tabId},url:'https://vk.com/fixture'}]; document.getElementById('refresh').click()`);
  await until(async () => evaluate(popupSession, "[...document.querySelectorAll('#tracks li')].some(row=>row.querySelector('strong').textContent==='Bitrate — MP3' && row.querySelector('.bitrate').textContent==='≈64 кбит/с')"), "popup shows cached bitrate");
  assert.equal(bitrateRequests.length, beforePopupProbes, "popup and row share probe cache");
  // A signed URL refresh must replace the old value rather than display stale quality.
  await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId},{type:'IMPORT_TRACKS',tracks:${JSON.stringify([{ ...probeTracks[0], url: "https://cs1-77v4.vkuseraudio.ru/bitrate/bitrate-low.mp3" }])}},{frameId:0})`);
  await call("Page.bringToFront", {}, pageSession);
  await until(async () => evaluate(pageSession, `${bitrateText(0)} === '≈32 кбит/с'`), "changed source invalidates bitrate");
  assert.equal(bitrateRequests.filter(url => url.endsWith('/bitrate.mp3')).length, 1);
  assert.equal(bitrateRequests.filter(url => url.endsWith('/bitrate-low.mp3')).length, 1);
  assert.equal(bitrateRequests.filter(url => /\/mp3-part\d+\.ts$/.test(url)).length, 1, "probe reads one HLS segment");
  await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId}, {type:'CLEAR_TRACKS'}, {frameId:0})`);
  const cleared = await evaluate(workerSession, `chrome.tabs.sendMessage(${tabId}, {type:'LIST_TRACKS'}, {frameId:0})`);
  assert.equal(cleared.tracks.length, 0);
  assert.equal(await evaluate(pageSession, `(${rowButton("inline-hls")}).disabled`), true);
  assert.deepEqual(browserErrors, []);
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  const report = { extensionVersion: "0.3.13", browser: version.product, extensionId, devtools: withDevtools, checked: ["MV3 worker loads", "content-script DOM discovery", "resource timing HLS discovery", "notification bb2.mp3 filtered", "al_audio.php without usable URLs plus independently discovered HLS", "empty, encoded and invalid URL counters without private values", "Media Session title available in isolated content script", "user-selected player name persists after track change", "stale player title selection rejected", "capture version and counters available", "replaced fetch hook repaired from popup", "catalog.getSection fetch response supplies exact names and durations", "XHR updates signed URLs without duplicate tracks", "API names survive DOM rescans", "popup displays API names and 3:18 duration", "messages.getHistory attachment supplies exact MP3 URL, name and duration", "message text and access keys excluded from track list and diagnostics", "encoded al_audio.php yields named MP3 and HLS", "decoded HLS upgrades existing resource without duplication", "viewer ID and masked placeholder URLs are not published", ...(withDevtools ? ["real DevTools captures messages.getHistory from an iframe without page hooks", "real DevTools decodes viewer-bound music URLs using inspectedWindow.eval"] : []), "background rejects START_DOWNLOAD from non-popup pages", "opaque API URL is identified as HLS and saved", "TS AAC extraction matches independent FFmpeg stream copy", "downloaded audio decodes with FFmpeg", "AES-128 HLS yields exact AAC including implicit IV, explicit IV, key rotation and METHOD=NONE", "decrypted HLS decodes with FFmpeg", "missing AES key stops before fetching media", "separate key origin pauses for permission", "MP3 extraction matches FFmpeg stream copy and decodes", "download page reports detected AAC/MP3 format", "truncated TS is rejected without saving", "lazy row controls match IDs instead of identical titles", "row controls enable on late metadata", "row controls survive rerender and reject stale row identity", "synthetic clicks and forged row grants do not download", "trusted mouse and keyboard row clicks save HLS and verified direct MP3 without playback", "clearing tracks disables row controls", "HTML and JSON with MP3 URL and MIME are rejected before Save As", "actual MP3 with HTML MIME and HTM disposition saves verified audio bytes", "one GET saves identical verified bytes without a second signed URL request", "HLS behind an MP3 URL follows the HLS path", "empty AFC=3 packets preserve MP3 and AAC across HLS segments", "empty packets survive AES-128 and match original FFmpeg audio", "ID3-tagged MP3 extracted unchanged and decoded by FFmpeg", "unknown MPEG header yields bounded diagnostics without private contents", "TS fallback saves retained bytes twice without refetch or MP3 mislabeling", "network and key failures never offer partial TS fallback", "VK audio CDN host permission covers root and subdomains in fresh profile", "CDN direct MP3 and HLS download without per-server grants", "unrelated and lookalike domains have no automatic host permission", "default background row downloads keep VK active", "popup preference persists across reload and enables foreground downloads", "auto-close defaults on and disabled preference persists", "direct MP3, HLS and TS fallback tabs close after confirmed save with exact bytes", "VK and error or permission tabs remain open", "visible rows show sampled MP3, HLS and AES-128 bitrate", "popup shares bitrate cache with inline controls", "changed audio URL replaces stale bitrate", "HLS bitrate uses one segment without saving a file", "clear list"], verificationRequests, rowDownloadCount: rowDownloads.length, mp3File: mp3Download.filename, hlsFile: hlsDownloads[0].filename, encryptedHlsFile: encryptedDownload.filename, runtimeErrors: browserErrors, vkAccountUsed: false };
  writeFileSync(resolve(root, "artifacts", withDevtools ? "browser-devtools-smoke.json" : "browser-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await call("Browser.close").catch(() => {});
  socket.close();
  if (child.exitCode === null) child.kill();
  for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Browser closed")); }
}
