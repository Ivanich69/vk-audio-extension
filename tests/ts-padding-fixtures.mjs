// Compatibility fixture: AFC=3 advertises payload, but its 183-byte adaptation
// field fills the entire TS packet. Account for its counter without audio bytes.
export function withEmptyTsPackets(bytes, shifts = new Map()) {
  if (bytes.length % 188) throw new Error("Fixture must contain complete TS packets");
  const parts = [];
  for (let i = 0; i < bytes.length; i += 188) {
    const packet = Buffer.from(bytes.subarray(i, i + 188));
    const pid = (packet[1] & 31) << 8 | packet[2];
    if (![0, 4096, 256].includes(pid)) { parts.push(packet); continue; }
    let shift = shifts.get(pid) || 0;
    let cc = ((packet[3] & 15) + shift) % 16;
    if (packet[3] & 0x10) {
      const empty = Buffer.alloc(188, 0xff);
      // Set PUSI deliberately: with no payload it must not flush PES or PSI.
      empty.set([0x47, 0x40 | pid >> 8, pid & 255, 0x30 | cc, 183, 0]);
      const adaptationOnly = Buffer.from(empty); adaptationOnly[3] = 0x20 | cc;
      parts.push(empty, Buffer.from(empty), adaptationOnly);
      shift++; cc = (cc + 1) % 16;
      shifts.set(pid, shift);
    }
    packet[3] = (packet[3] & 0xf0) | cc;
    parts.push(packet);
  }
  return Buffer.concat(parts);
}
