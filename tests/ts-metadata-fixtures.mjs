import { readFileSync } from "node:fs";

export function id3Tag(version = 4, footer = false) {
  const text = Buffer.from("\0private-fixture-token");
  const frame = version === 2 ? Buffer.from([0x54, 0x54, 0x32, 0, 0, text.length]) :
    Buffer.from([0x54, 0x49, 0x54, 0x32, 0, 0, 0, text.length, 0, 0]);
  const body = Buffer.concat([frame, text]);
  const header = Buffer.from([0x49, 0x44, 0x33, version, 0, footer ? 0x10 : 0, 0, 0, 0, body.length]);
  const end = Buffer.from(header); end.set([0x33, 0x44, 0x49]);
  return Buffer.concat([header, body, ...(footer ? [end] : [])]);
}

// Repacketize a small elementary MP3 fixture as a single length-delimited PES.
export function mp3Transport(audio) {
  if (audio.length + 3 > 65535) throw new Error("Fixture PES is too large");
  const source = readFileSync(new URL("./fixtures/ts/mp3.ts", import.meta.url));
  const tables = [];
  const seen = new Set();
  for (let offset = 0; offset < source.length; offset += 188) {
    const packet = source.subarray(offset, offset + 188);
    const pid = (packet[1] & 31) << 8 | packet[2];
    if ([0, 4096].includes(pid) && !seen.has(pid)) { tables.push(packet); seen.add(pid); }
  }
  const length = audio.length + 3;
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xc0, length >> 8, length & 255, 0x80, 0, 0]), audio]);
  const packets = [...tables];
  for (let offset = 0, cc = 0; offset < pes.length; offset += 183, cc++) {
    const part = pes.subarray(offset, offset + 183);
    const packet = Buffer.alloc(188, 0xff);
    packet.set([0x47, offset === 0 ? 0x41 : 1, 0, 0x30 | (cc % 16), 183 - part.length]);
    if (packet[4]) packet[5] = 0;
    packet.set(part, 188 - part.length);
    packets.push(packet);
  }
  return Buffer.concat(packets);
}
