import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { filename } from "../lib/media.js";

const source = readFileSync(new URL("../download.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").split("\ninit().catch")[0];
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ state = "in_progress", autoClose = true, removalFails = false } = {}) {
  const elements = new Map(), removed = [], revoked = [];
  let changed;
  const el = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: 0, max: 1, addEventListener() {} });
    return elements.get(id);
  };
  const context = {
    document: { getElementById: el }, AbortController, filename,
    URL: { revokeObjectURL: url => revoked.push(url) },
    chrome: {
      downloads: { download: async () => 23, search: async () => [{ id: 23, state }],
        cancel: async () => {}, onChanged: { addListener: listener => { changed = listener; } } },
      tabs: { getCurrent: async () => ({ id: 91 }), remove: async id => {
        if (removalFails) throw new Error("Cannot remove");
        removed.push(id);
      } }
    }
  };
  runInNewContext(source + `\njob={title:'Fixture'}; controller=new AbortController(); blobUrl='blob:fixture'; autoCloseDownloads=${autoClose}; globalThis.saveFile=()=>save(blobUrl,'mp3');`, context);
  return { el, removed, revoked, save: context.saveFile, event: delta => changed(delta) };
}

test("only completion of this download closes its own tab, once", async () => {
  const h = harness();
  await h.save();
  assert.deepEqual(h.removed, []);
  h.event({ id: 99, state: { current: "complete" } });
  await tick();
  assert.deepEqual(h.removed, []);
  h.event({ id: 23, state: { current: "complete" } });
  h.event({ id: 23, state: { current: "complete" } });
  await tick();
  assert.deepEqual(h.removed, [91]);
  assert.deepEqual(h.revoked, ["blob:fixture"]);
});

test("download completed before listener registration still closes through state lookup", async () => {
  const h = harness({ state: "complete" });
  await h.save(); await tick();
  assert.deepEqual(h.removed, [91]);
});

test("cancelled or interrupted download remains available for retry", async () => {
  const h = harness();
  await h.save();
  h.event({ id: 23, state: { current: "interrupted" } });
  await tick();
  assert.deepEqual(h.removed, []);
  assert.equal(h.el("start").hidden, false);
});

test("disabled auto-close preserves completed page", async () => {
  const h = harness({ state: "complete", autoClose: false });
  await h.save(); await tick();
  assert.deepEqual(h.removed, []);
  assert.equal(h.el("start").hidden, false);
});

test("tab removal failure does not report a failed download or lose retry controls", async () => {
  const h = harness({ state: "complete", removalFails: true });
  await h.save(); await tick();
  assert.equal(h.el("start").hidden, false);
  assert.match(h.el("status").textContent, /Файл сохранён/);
  assert.match(h.el("status").textContent, /вручную/);
  assert.equal(h.el("status").className, "");
});
