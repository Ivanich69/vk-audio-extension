// Extract elementary audio without decoding/re-encoding it. No remote libraries.
import { MAX_BYTES } from "./hls.js";

function invalid(detail) {
  throw new Error(`Не удалось извлечь аудио из TS: ${detail}.`);
}

function join(parts, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

// PSI sections can span packets, with a pointer before the next section.
class Sections {
  bytes = [];
  feed(payload, start, receive) {
    let offset = 0;
    if (start) {
      const pointer = payload[offset++];
      if (pointer > payload.length - offset) invalid("повреждён указатель таблицы");
      if (this.bytes.length) {
        this.append(payload.subarray(offset, offset + pointer), receive);
        if (this.bytes.length) invalid("обрезана таблица потока");
      }
      offset += pointer;
    } else if (!this.bytes.length) return;
    this.append(payload.subarray(offset), receive);
  }
  append(bytes, receive) {
    for (const byte of bytes) {
      if (!this.bytes.length && byte === 0xff) return;
      this.bytes.push(byte);
      if (this.bytes.length < 3) continue;
      const size = 3 + ((this.bytes[1] & 15) << 8 | this.bytes[2]);
      if (size < 12 || size > 1024) invalid("некорректная длина таблицы");
      if (this.bytes.length === size) {
        const section = Uint8Array.from(this.bytes);
        this.bytes = [];
        if (crc32(section)) invalid("неверная контрольная сумма таблицы");
        if (!(section[1] & 0x80)) invalid("неверный заголовок таблицы");
        if (!(section[5] & 1)) continue;
        if (section[6] || section[7]) invalid("таблица из нескольких секций пока не поддерживается");
        receive(section);
      }
    }
  }
}

// Validate every frame, including the last one: a truncated track must not be saved.
export function validateAudio(bytes, type, partialSample = false) {
  let offset = 0;
  let frames = 0;
  let tags = 0;
  let audioBytes = 0;
  let seconds = 0;
  try {
    while (offset < bytes.length) {
      const b = bytes.subarray(offset);
      let size;
      let frameSeconds;
      if (partialSample && frames >= 2 && b.length < (type === 0x0f ? 7 : 4)) break;
      // Tags are accepted only at a verified frame boundary. Never scan past
      // unknown bytes: doing so could silently save a damaged/shortened track.
      if (type !== 0x0f && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
        if (b.length < 10 || ![2, 3, 4].includes(b[3]) || b[4] === 255 ||
            (b[5] & (b[3] === 2 ? 0x3f : b[3] === 3 ? 0x1f : 0x0f)) ||
            b.subarray(6, 10).some(byte => byte & 0x80)) invalid("неверный заголовок ID3");
        const bodySize = b[6] * 2097152 + b[7] * 16384 + b[8] * 128 + b[9];
        const footer = b[3] === 4 && (b[5] & 0x10);
        size = 10 + bodySize + (footer ? 10 : 0);
        if (size > b.length) invalid("тег ID3 обрезан");
        if (footer) {
          const end = b.subarray(size - 10, size);
          if (end[0] !== 0x33 || end[1] !== 0x44 || end[2] !== 0x49 ||
              end.subarray(3).some((byte, i) => byte !== b[i + 3])) invalid("неверный завершающий заголовок ID3");
        }
        offset += size;
        tags++;
        continue;
      }
      if (type !== 0x0f && frames && b.length === 128 && b[0] === 0x54 && b[1] === 0x41 && b[2] === 0x47) {
        offset += 128;
        tags++;
        continue;
      }
      if (type === 0x0f) {
        if (b.length < 7 || b[0] !== 0xff || (b[1] & 0xf6) !== 0xf0 || (b[2] >> 2 & 15) > 12) invalid("неверный заголовок AAC/ADTS");
        size = (b[3] & 3) << 11 | b[4] << 3 | b[5] >> 5;
        if (size < (b[1] & 1 ? 7 : 9)) invalid("неверная длина AAC-кадра");
        const rate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][b[2] >> 2 & 15];
        frameSeconds = 1024 * ((b[6] & 3) + 1) / rate;
      } else {
        if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) invalid("неверный заголовок MPEG Audio");
        const version = b[1] >> 3 & 3;
        const layer = b[1] >> 1 & 3;
        const bitrateIndex = b[2] >> 4;
        const rateIndex = b[2] >> 2 & 3;
        if (layer !== 1) invalid("поддержан MPEG Layer III (MP3), другие слои пока не поддерживаются");
        if (version === 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) invalid("неподдерживаемый заголовок MP3");
        const rates = [44100, 48000, 32000];
        const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        const rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
        size = Math.floor((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / rate) + (b[2] >> 1 & 1);
        frameSeconds = (version === 3 ? 1152 : 576) / rate;
      }
      if (partialSample && frames >= 2 && size > b.length) break;
      if (size > b.length) invalid("последний аудиокадр обрезан");
      audioBytes += size;
      seconds += frameSeconds;
      offset += size;
      frames++;
    }
    if (!frames || (partialSample && frames < 2)) invalid("аудиокадры не найдены");
  } catch (error) {
    const b = bytes.subarray(offset);
    const signature = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 ? "ID3" :
      b[0] === 0xff && (b[1] & 0xf6) === 0xf0 ? "ADTS-like" :
      b[0] === 0xff && (b[1] & 0xe0) === 0xe0 ? "MPEG-like" :
      b[0] === 0 ? "zero" : b.length ? "unknown" : "end";
    // Counts and format classification only; no track data, URLs or ID3 text.
    error.diagnostics = { stage: "audio-frames", streamType: type, audioBytes: bytes.length,
      offset, remainingBytes: b.length, frames, tags, signature };
    throw error;
  }
  return { ...(type === 0x0f ? { extension: "aac", mime: "audio/aac" } : { extension: "mp3", mime: "audio/mpeg" }),
    bitrateKbps: Math.round(audioBytes * 8 / seconds / 1000) };
}

export class TsAudioExtractor {
  pat = new Sections();
  pmt = new Sections();
  pmtPid;
  program;
  audioPid;
  type;
  counters = new Map();
  pes = [];
  pesSize = 0;
  parts = [];
  size = 0;
  inputSize = 0;

  readPAT(s) {
    if (s[0] !== 0 || (s.length - 12) % 4) invalid("неверная PAT");
    const programs = [];
    for (let i = 8; i < s.length - 4; i += 4) {
      const program = s[i] << 8 | s[i + 1];
      if (program) programs.push({ program, pid: (s[i + 2] & 31) << 8 | s[i + 3] });
    }
    if (programs.length !== 1) invalid("ожидалась одна программа в TS");
    const { program, pid } = programs[0];
    if (this.pmtPid !== undefined && (this.pmtPid !== pid || this.program !== program)) invalid("программа потока изменилась");
    this.pmtPid = pid;
    this.program = program;
  }

  readPMT(s) {
    if (s[0] !== 2 || s.length < 16 || (s[3] << 8 | s[4]) !== this.program) invalid("неверная PMT");
    const audio = [];
    let i = 12 + ((s[10] & 15) << 8 | s[11]);
    for (; i < s.length - 4;) {
      if (i + 5 > s.length - 4) invalid("обрезана запись PMT");
      const type = s[i], pid = (s[i + 1] & 31) << 8 | s[i + 2];
      // Refuse ambiguous/unsupported audio instead of silently choosing a track.
      if ([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87, 0x06].includes(type)) audio.push({ type, pid });
      i += 5 + ((s[i + 3] & 15) << 8 | s[i + 4]);
    }
    if (i !== s.length - 4) invalid("повреждены дескрипторы PMT");
    if (audio.length !== 1 || ![0x03, 0x04, 0x0f].includes(audio[0].type)) invalid("нужна одна дорожка MP3 или AAC/ADTS");
    const { pid, type } = audio[0];
    if (this.audioPid !== undefined && (this.audioPid !== pid || this.type !== type)) invalid("аудиодорожка изменилась");
    this.audioPid = pid;
    this.type = type;
  }

  flushPES() {
    if (!this.pesSize) return;
    const bytes = join(this.pes, this.pesSize);
    this.pes = []; this.pesSize = 0;
    if (bytes.length < 9 || bytes[0] || bytes[1] || bytes[2] !== 1 || !((bytes[3] >= 0xc0 && bytes[3] <= 0xdf) || bytes[3] === 0xbd) || (bytes[6] & 0xc0) !== 0x80) invalid("неверный заголовок PES");
    if (bytes[6] & 0x30) invalid("зашифрованный PES не поддерживается");
    const length = bytes[4] << 8 | bytes[5];
    const end = length ? length + 6 : bytes.length;
    const start = 9 + bytes[8];
    if (end > bytes.length || start >= end) invalid("обрезан аудиопакет PES");
    if (bytes.subarray(end).some(byte => byte !== 0xff)) invalid("лишние данные после PES");
    this.parts.push(bytes.subarray(start, end));
    this.size += end - start;
  }

  push(bytes) {
    this.inputSize += bytes.length;
    if (this.inputSize > MAX_BYTES) invalid("превышен лимит 256 МБ");
    if (!bytes.length || bytes.length % 188) invalid("обрезан транспортный пакет");
    for (let offset = 0; offset < bytes.length; offset += 188) {
      const packet = bytes.subarray(offset, offset + 188);
      if (packet[0] !== 0x47) invalid("потеряна синхронизация TS");
      const pid = (packet[1] & 31) << 8 | packet[2];
      if (pid !== 0 && pid !== this.pmtPid && pid !== this.audioPid) continue;
      if (packet[1] & 0x80 || packet[3] & 0xc0) invalid("повреждён или зашифрован транспортный пакет");
      const control = packet[3] >> 4 & 3;
      if (!control) invalid("неверный заголовок TS");
      let start = 4;
      if (control & 2) {
        start += 1 + packet[4];
        if (start > 188 || (packet[4] && packet[5] & 0x80)) invalid("обрыв или смена транспортного потока");
      }
      if (!(control & 1)) continue;
      const cc = packet[3] & 15;
      const previous = this.counters.get(pid);
      if (previous) {
        if (cc === previous.cc && packet.every((byte, i) => byte === previous.packet[i])) continue;
        if (cc !== (previous.cc + 1) % 16) invalid("пропущен или повреждён пакет потока");
      }
      this.counters.set(pid, { cc, packet: packet.slice() });
      // Compatibility with AFC=3 packets whose adaptation field fills all 188
      // bytes: consume the advertised payload counter, but no PSI/PES data.
      // In particular, an empty PUSI must not terminate the current PES.
      if (start === 188) continue;
      const payload = packet.subarray(start);
      const begins = Boolean(packet[1] & 0x40);
      if (pid === 0) this.pat.feed(payload, begins, s => this.readPAT(s));
      else if (pid === this.pmtPid) this.pmt.feed(payload, begins, s => this.readPMT(s));
      else {
        if (begins) this.flushPES();
        else if (!this.pesSize) invalid("отсутствует начало аудиопакета");
        this.pes.push(payload.slice());
        this.pesSize += payload.length;
        if (this.pesSize > 2 * 1024 * 1024) invalid("слишком большой аудиопакет PES");
      }
    }
  }

  finish() {
    if (this.pat.bytes.length || this.pmt.bytes.length) invalid("обрезана таблица потока");
    if (this.audioPid === undefined) invalid("аудиодорожка не найдена");
    this.flushPES();
    const bytes = join(this.parts, this.size);
    this.parts = [];
    return { bytes, ...validateAudio(bytes, this.type) };
  }

  // A probe can stop mid-PES or mid-frame. Inspect only completed PES packets;
  // leave the pending one untouched so the next HLS segment can complete it.
  sample() {
    if (this.audioPid === undefined) invalid("аудиодорожка не найдена");
    if (this.pesSize >= 9) {
      const header = join(this.pes, this.pesSize);
      const length = header[4] << 8 | header[5];
      if (length && length + 6 <= this.pesSize) this.flushPES();
    }
    return validateAudio(join(this.parts, this.size), this.type, true);
  }
}
