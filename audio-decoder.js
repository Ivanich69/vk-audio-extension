/* VK URL transformations adapted from python273/vk_api, Apache-2.0.
 * See THIRD_PARTY.md and licenses/vk_api-Apache-2.0.txt.
 * Modified: JavaScript implementation with bounded input, explicit failure
 * reasons, URL validation and no network requests or executable payloads.
 */
(() => {
  "use strict";
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";
  function unpack(input) {
    if (input.length > 16384 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(input)) throw new Error("format");
    const source = input.replace(/=+$/, "");
    if (source.length % 4 === 1) throw new Error("format");
    let buffer = 0, bits = 0, output = "";
    for (const char of source) {
      buffer = (buffer << 6) | alphabet.indexOf(char);
      bits += 6;
      if (bits >= 8) { bits -= 8; output += String.fromCharCode((buffer >>> bits) & 255); }
    }
    return output;
  }
  function integer(value) {
    if (!/^-?\d{1,10}$/.test(value || "")) throw new Error("format");
    const result = Number(value);
    if (!Number.isInteger(result) || result < -2147483648 || result > 2147483647) throw new Error("format");
    return result;
  }
  function shuffle(text, seed) {
    const size = text.length;
    const positions = new Int32Array(size);
    let state = Math.abs(seed);
    for (let index = size - 1; index >= 0; index--) {
      state = (size * (index + 1) ^ (state + index)) % size;
      positions[index] = state;
    }
    const chars = text.split("");
    for (let index = 1; index < size; index++) {
      const raw = positions[size - 1 - index];
      const other = raw < 0 ? size + raw : raw;
      [chars[index], chars[other]] = [chars[other], chars[index]];
    }
    return chars.join("");
  }
  function decode(value, viewerId = 0) {
    const failure = reason => ({ url: null, reason });
    if (typeof value !== "string" || value.length > 16384) return failure("format");
    try {
      const input = new URL(value);
      if (input.protocol !== "https:" || !/(^|\.)vk\.(com|ru)$/.test(input.hostname) ||
          !input.pathname.includes("audio_api_unavailable") || input.username || input.password) return failure("format");
      // URLSearchParams would turn literal '+' in VK's alphabet into spaces.
      const encoded = /(?:^|[?&])extra=([^&]*)/.exec(input.search)?.[1];
      if (!encoded) return failure("format");
      let text = unpack(decodeURIComponent(encoded));
      const instructions = input.hash ? unpack(decodeURIComponent(input.hash.slice(1))) : "";
      const operations = instructions ? instructions.split("\t") : [];
      if (operations.length > 16) return failure("format");
      for (const instruction of operations.reverse()) {
        const [command, argument, extra] = instruction.split("\v");
        if (extra !== undefined) return failure("format");
        if (command === "v") text = text.split("").reverse().join("");
        else if (command === "r") {
          const shift = integer(argument);
          if (Math.abs(shift) > 64) return failure("format");
          const doubled = alphabet + alphabet;
          text = [...text].map(char => {
            const index = alphabet.indexOf(char);
            return index < 0 ? char : doubled.substr(index - shift, 1);
          }).join("");
        } else if (command === "x") {
          if (!argument) return failure("format");
          const key = argument.charCodeAt(0);
          text = text.split("").map(char => String.fromCharCode(char.charCodeAt(0) ^ key)).join("");
        } else if (command === "s" || command === "i") {
          let seed = integer(argument);
          if (command === "i") {
            if (!Number.isSafeInteger(viewerId) || viewerId <= 0) return failure("needsUserId");
            seed ^= viewerId;
          }
          text = shuffle(text, seed);
        } else return failure("unsupported");
      }
      if (!/^https:\/\//.test(text) || /[\x00-\x20\x7f]/.test(text)) return failure("invalidResult");
      const result = new URL(text);
      if (result.username || result.password || result.href.includes("audio_api_unavailable")) return failure("invalidResult");
      return { url: result.href, reason: "" };
    } catch { return failure("format"); }
  }
  globalThis[Symbol.for("vk-audio.decoder.v1")] = Object.freeze({ decode });
})();
