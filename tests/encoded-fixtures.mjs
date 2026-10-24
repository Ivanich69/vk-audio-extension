// Inverse encoder for local fixtures only. Never imported by the extension.
const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const vk64 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";
function encode(value) {
  return Buffer.from(value, "latin1").toString("base64").replace(/=+$/, "").split("").map(char => vk64[base64.indexOf(char)]).join("");
}
export function maskedUrl(url, operations = [], viewerId = 0) {
  let value = url;
  for (const [command, argument] of operations) {
    if (command === "v") value = value.split("").reverse().join("");
    else if (command === "x") value = value.split("").map(char => String.fromCharCode(char.charCodeAt(0) ^ String(argument).charCodeAt(0))).join("");
    else if (command === "r") value = [...value].map(char => {
      const index = vk64.indexOf(char);
      return index < 0 ? char : vk64[(index + Number(argument) + vk64.length) % vk64.length];
    }).join("");
    else if (command === "s" || command === "i") {
      const size = value.length;
      let seed = Math.abs(command === "i" ? Number(argument) ^ viewerId : Number(argument));
      const positions = [];
      for (let a = size; a > 0; a--) {
        seed = (size * a ^ (seed + a - 1)) % size;
        positions.unshift(seed < 0 ? size + seed : seed);
      }
      const chars = value.split("");
      // Encoding reverses the decoding permutation.
      for (let a = size - 1; a > 0; a--) {
        const b = positions[size - 1 - a];
        const old = chars[a]; chars[a] = chars[b]; chars[b] = old;
      }
      value = chars.join("");
    } else throw new Error("Unknown fixture operation");
  }
  const commands = operations.map(op => op.join("\v")).join("\t");
  return `https://vk.ru/mp3/audio_api_unavailable.mp3?extra=${encode(value)}#${encode(commands)}`;
}
