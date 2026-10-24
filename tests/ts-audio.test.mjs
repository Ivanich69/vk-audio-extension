import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TsAudioExtractor, validateAudio } from "../lib/ts-audio.js";
import { withEmptyTsPackets } from "./ts-padding-fixtures.mjs";
import { id3Tag, mp3Transport } from "./ts-metadata-fixtures.mjs";

const fixture = name => readFileSync(new URL(`./fixtures/ts/${name}`, import.meta.url));
function extract(bytes, packetStep = 7) {
  const extractor = new TsAudioExtractor();
  for (let i = 0; i < bytes.length; i += 188 * packetStep) extractor.push(bytes.subarray(i, i + 188 * packetStep));
  return extractor.finish();
}
function packets(bytes) {
  return Array.from({ length: bytes.length / 188 }, (_, i) => bytes.subarray(i * 188, (i + 1) * 188));
}
const pid = p => (p[1] & 31) << 8 | p[2];
function audioPackets(bytes) { return packets(bytes).filter(p => pid(p) === 256); }

for (const name of ["aac", "mp3", "mp3-low", "mp3-lowest"]) {
  test(`extract ${name} bit-for-bit against FFmpeg stream copy, across segment boundaries`, () => {
    const expected = fixture(`${name}.audio`);
    for (const step of [1, 7, 10000]) {
      const result = extract(fixture(`${name}.ts`), step);
      assert.deepEqual(Buffer.from(result.bytes), expected);
      assert.equal(result.extension, name === "aac" ? "aac" : "mp3");
      assert.equal(result.mime, name === "aac" ? "audio/aac" : "audio/mpeg");
    }
  });
}

test("identical retransmitted TS packet is ignored without duplicated audio", () => {
  const source = packets(fixture("mp3.ts"));
  const index = source.findIndex(p => pid(p) === 256);
  source.splice(index + 1, 0, source[index]);
  assert.deepEqual(Buffer.from(extract(Buffer.concat(source)).bytes), fixture("mp3.audio"));
});

test("packet loss and conflicting continuity counters stop extraction", () => {
  const source = packets(fixture("aac.ts"));
  const index = source.findIndex(p => pid(p) === 256 && !(p[1] & 0x40));
  const missing = [...source]; missing.splice(index, 1);
  assert.throws(() => extract(Buffer.concat(missing)), /пакет потока/);
  const damaged = Buffer.from(source[index]); damaged[187] ^= 1;
  const duplicated = [...source]; duplicated.splice(index + 1, 0, damaged);
  assert.throws(() => extract(Buffer.concat(duplicated)), /пакет потока/);
});

test("truncated packet, PES and elementary audio are rejected", () => {
  const source = fixture("aac.ts");
  assert.throws(() => extract(source.subarray(0, -1)), /транспортный пакет/);
  const parts = packets(source);
  const last = parts.findLastIndex(p => pid(p) === 256);
  assert.throws(() => extract(Buffer.concat(parts.slice(0, last))), /обрезан/);
  for (const name of ["aac", "mp3"]) {
    assert.throws(() => validateAudio(fixture(`${name}.audio`).subarray(0, -1), name === "aac" ? 15 : 3), /обрезан/);
  }
});

test("corrupted PAT/PMT CRC, sync and transport errors are rejected", () => {
  for (const target of [0, 4096]) {
    const source = fixture("aac.ts");
    const packet = packets(source).find(p => pid(p) === target);
    assert.ok(packet);
    packet[12] ^= 1;
    assert.throws(() => extract(source), /контрольная сумма/);
  }
  const source = fixture("mp3.ts"); source[0] = 0;
  assert.throws(() => extract(source), /синхронизация/);
  for (const [byte, flag] of [[1, 0x80], [3, 0x80]]) {
    const bytes = fixture("mp3.ts"); audioPackets(bytes)[0][byte] |= flag;
    assert.throws(() => extract(bytes), /повреждён или зашифрован/);
  }
});

test("MPEG Layer II cannot masquerade as MP3", () => {
  const bytes = fixture("mp3.audio"); bytes[1] = (bytes[1] & ~6) | 4;
  assert.throws(() => validateAudio(bytes, 3), /Layer III/);
});

test("empty transport and streams without audio tables fail", () => {
  assert.throws(() => new TsAudioExtractor().finish(), /не найдена/);
  assert.throws(() => extract(Buffer.concat(packets(fixture("aac.ts")).filter(p => pid(p) !== 4096))), /не найдена/);
});

function payload(packet) {
  return packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
}
function packetFor(id, data, start, cc) {
  assert.ok(data.length <= 183);
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, (id >> 8) | (start ? 0x40 : 0), id & 255, 0x30 | cc]);
  packet[4] = 183 - data.length;
  if (packet[4]) packet[5] = 0;
  packet.set(data, 188 - data.length);
  return packet;
}
function tables(bytes) { return packets(bytes).filter(p => pid(p) === 0 || pid(p) === 4096).slice(0, 2); }

test("PSI sections and PES headers may span TS packets and input segments", () => {
  const source = fixture("mp3.ts");
  const [pat, pmt] = tables(source);
  const pmtData = payload(pmt).subarray(1);
  const sectionSize = 3 + ((pmtData[1] & 15) << 8 | pmtData[2]);
  const section = pmtData.subarray(0, sectionSize);
  const output = [pat, packetFor(4096, Buffer.concat([Buffer.from([0]), section.subarray(0, 10)]), true, 0), packetFor(4096, section.subarray(10), false, 1)];
  const audio = audioPackets(source);
  const first = payload(audio[0]);
  output.push(packetFor(256, first.subarray(0, 7), true, 0), packetFor(256, first.subarray(7), false, 1));
  for (let i = 1; i < audio.length; i++) {
    const packet = Buffer.from(audio[i]);
    packet[3] = (packet[3] & 0xf0) | ((i + 1) % 16);
    output.push(packet);
  }
  assert.deepEqual(Buffer.from(extract(Buffer.concat(output), 1).bytes), fixture("mp3.audio"));
});

test("AAC LATM in a valid PMT fails instead of being labeled MP3/AAC ADTS", () => {
  const source = fixture("aac.ts");
  const pmt = packets(source).find(p => pid(p) === 4096);
  const section = payload(pmt).subarray(1);
  const size = 3 + ((section[1] & 15) << 8 | section[2]);
  section[12] = 0x11;
  let crc = 0xffffffff;
  for (const byte of section.subarray(0, size - 4)) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  section.writeUInt32BE(crc >>> 0, size - 4);
  assert.throws(() => extract(source), /дорожка MP3 или AAC/);
});

for (const name of ["mp3", "aac"]) {
  test(`empty AFC=3 and adaptation-only packets preserve ${name}, PSI/PES and counter wrap`, () => {
    const bytes = withEmptyTsPackets(fixture(`${name}.ts`));
    for (const step of [1, 7, 10000]) {
      assert.deepEqual(Buffer.from(extract(bytes, step).bytes), fixture(`${name}.audio`));
    }
  });
}

test("empty packet compatibility does not hide missing audio packets", () => {
  const source = packets(withEmptyTsPackets(fixture("aac.ts")));
  const index = source.findIndex(p => pid(p) === 256 && (p[3] & 0x10) && !(p[1] & 0x40) && payload(p).length);
  assert.ok(index > 0);
  source.splice(index, 1);
  assert.throws(() => extract(Buffer.concat(source)), /пакет потока/);
});

test("overlong adaptation fields and discontinuity are still rejected", () => {
  for (const [byte, value] of [[4, 184], [5, 0x80]]) {
    const source = withEmptyTsPackets(fixture("mp3.ts"));
    const empty = audioPackets(source).find(p => (p[3] & 0x30) === 0x30 && p[4] === 183);
    empty[byte] = value;
    assert.throws(() => extract(source), /обрыв или смена/);
  }
});

test("ID3v2.2/2.3/2.4, footer and final ID3v1 preserve MP3 bytes across TS packets", () => {
  const audio = fixture("mp3.audio");
  const tail = Buffer.alloc(128); tail.write("TAG");
  for (const [version, footer] of [[2, false], [3, false], [4, false], [4, true]]) {
    const tagged = Buffer.concat([id3Tag(version, footer), audio, id3Tag(version, footer), audio, tail]);
    const result = extract(mp3Transport(tagged), 1);
    assert.equal(result.extension, "mp3");
    assert.deepEqual(Buffer.from(result.bytes), tagged);
  }
});

test("malformed ID3 length, flags, footer and metadata-only data cannot become MP3", () => {
  const audio = fixture("mp3.audio");
  for (const [index, byte] of [[3, 5], [4, 255], [5, 1], [6, 128], [9, 127]]) {
    const tag = id3Tag(); tag[index] = byte;
    assert.throws(() => validateAudio(Buffer.concat([tag, audio]), 3));
  }
  const footer = id3Tag(4, true); footer[footer.length - 1] ^= 1;
  assert.throws(() => validateAudio(Buffer.concat([footer, audio]), 3), /ID3/);
  assert.throws(() => validateAudio(id3Tag().subarray(0, -1), 3), /обрезан/);
  assert.throws(() => validateAudio(id3Tag(), 3), /не найдены/);
});

test("unknown bytes are not skipped and failure diagnostics expose no tag contents", () => {
  const audio = fixture("mp3.audio");
  for (const atStart of [true, false]) {
    const prefix = atStart ? Buffer.alloc(0) : Buffer.concat([id3Tag(), audio]);
    const bytes = Buffer.concat([prefix, Buffer.from("private-fixture-token"), audio]);
    assert.throws(() => extract(mp3Transport(bytes)), error => {
      assert.match(error.message, /неверный заголовок MPEG Audio/);
      assert.equal(error.diagnostics.offset, prefix.length);
      assert.equal(error.diagnostics.signature, "unknown");
      assert.equal(error.diagnostics.streamType, 3);
      assert.equal(error.diagnostics.frames > 0, !atStart);
      assert.equal(JSON.stringify(error.diagnostics).includes("private-fixture-token"), false);
      return true;
    });
  }
});
