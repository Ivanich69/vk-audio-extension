(() => {
  "use strict";
  const KEY = Symbol.for("vk-audio.resolver.v1");
  if (window[KEY]) return;
  const parser = window[Symbol.for("vk-audio.parser.v3")];
  const metadata = new Map();
  const jobs = new Map();
  const queue = [];
  const validId = value => typeof value === "string" && /^-?\d{1,24}_-?\d{1,24}$/.test(value);
  const token = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,256}$/.test(value) ? value : "";
  let active = 0;

  function remember(raw, fields) {
    const id = `${fields.owner_id}_${fields.id}`;
    if (!validId(id)) return;
    const hashText = Array.isArray(raw) ? raw[13] : raw.hashes;
    const hashes = typeof hashText === "string" ? hashText.split("/") : [];
    const previous = metadata.get(id) || {};
    const info = {
      action: token(hashes[2] || raw.actionHash) || previous.action || "",
      url: token(hashes[5] || raw.urlHash) || previous.url || "",
      access: token(Array.isArray(raw) ? raw[24] : raw.access_key || raw.accessKey) || previous.access || ""
    };
    if (metadata.size >= 1000 && !metadata.has(id)) metadata.delete(metadata.keys().next().value);
    metadata.set(id, info);
  }

  function fromDOM(id) {
    for (const row of document.querySelectorAll("[data-audio]")) {
      const text = row.getAttribute("data-audio");
      if (!text || text.length > 65536) continue;
      try {
        const raw = JSON.parse(text);
        const fields = Array.isArray(raw) ? { id: raw[0], owner_id: raw[1] } : raw;
        if (`${fields.owner_id}_${fields.id}` === id) { remember(raw, fields); break; }
      } catch { /* Only read structured metadata, never execute page text. */ }
    }
    return metadata.get(id) || {};
  }

  function extract(payload, id) {
    return parser.extract(payload, false, Number(window.vk?.id) || 0, remember).tracks.find(track => track.audioId === id) || null;
  }

  async function request(id) {
    const info = fromDOM(id);
    // Request metadata only. Never call the player's play/pause/setTrack APIs.
    {
      try {
        const response = await window.fetch("/al_audio.php", {
          method: "POST", credentials: "same-origin", redirect: "error",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: new URLSearchParams({ act: "reload_audio", al: "1", ids: `${id}_${info.action || ""}_${info.url || ""}` }).toString(),
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
          const reader = response.body?.getReader();
          if (reader) {
            const decoder = new TextDecoder(); let text = "", size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.length; if (size > parser.MAX_BODY) break;
                text += decoder.decode(value, { stream: true });
              }
              if (size <= parser.MAX_BODY) {
                const track = extract(text + decoder.decode(), id);
                if (track) return track;
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          }
        }
      } catch { /* The site's metadata API below may still be available. */ }
    }
    // Use the authenticated API wrapper already present on this VK page.
    // No tokens are read, stored in extension storage, or sent through the bridge.
    if (typeof window.vkApi?.api === "function") {
      let timer;
      try {
        const result = await Promise.race([
          window.vkApi.api("audio.getById", { audios: id + (info.access ? `_${info.access}` : "") }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); })
        ]);
        return extract(result, id);
      } catch { /* Keep the captured source if metadata refresh is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    return null;
  }

  async function refresh(id) {
    if (!validId(id) || !/^https:\/\/(?:[a-z0-9-]+\.)*vk\.(com|ru)(?:\/|$)/i.test(location.href)) return null;
    const previous = jobs.get(id);
    if (previous && (previous.pending || previous.until > Date.now())) return previous.promise;
    if (queue.length >= 32) return null;
    if (jobs.size >= 1000) {
      const oldest = [...jobs].find(([, job]) => !job.pending);
      if (oldest) jobs.delete(oldest[0]);
    }
    const job = { pending: true, until: 0 };
    job.promise = new Promise(resolve => {
      queue.push(async () => {
        const result = await request(id).catch(() => null);
        job.pending = false; job.until = Date.now() + (result ? 60000 : 10000);
        resolve(result);
      });
    });
    jobs.set(id, job);
    drain();
    return job.promise;
  }
  function drain() {
    while (active < 2 && queue.length) {
      const task = queue.shift(); active++;
      task().finally(() => { active--; drain(); });
    }
  }
  window[KEY] = Object.freeze({ remember, refresh });
})();
