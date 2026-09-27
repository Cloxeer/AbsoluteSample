/**
 * Keeps exports identical in shape to what the user uploaded: same length (sample-exact), same
 * channels, same sample rate and (for WAV) the same bit depth. Compressed inputs (MP3/AAC/OGG)
 * export as 24-bit WAV at their decoded rate.
 */

export type Container = "wav" | "flac" | "mp3" | "m4a" | "ogg" | "other";

export interface SourceFormat {
  container: Container;
  /** Native sample rate from the file header, when readable (WAV/FLAC). */
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  float: boolean;
}

export interface DecodedTrack {
  /** Original channels (1 or 2), same length. */
  channels: Float32Array[];
  /** Mono mix used for pitch analysis. */
  mono: Float32Array;
  sampleRate: number;
  format: SourceFormat;
}

export interface WavSpec {
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  float: boolean;
}

const ascii = (v: DataView, off: number, n: number) => {
  let s = "";
  for (let i = 0; i < n && off + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(off + i));
  return s;
};

/** Reads the container and, for WAV/FLAC, the native rate / channels / bit depth from the header. */
export function sniffFormat(bytes: ArrayBuffer, fileName = ""): SourceFormat {
  const v = new DataView(bytes);
  const unknown = (container: Container): SourceFormat => ({ container, sampleRate: null, channels: null, bitDepth: null, float: false });
  if (v.byteLength >= 12 && ascii(v, 0, 4) === "RIFF" && ascii(v, 8, 4) === "WAVE") {
    let off = 12;
    while (off + 8 <= v.byteLength) {
      const id = ascii(v, off, 4);
      const size = v.getUint32(off + 4, true);
      if (id === "fmt " && off + 24 <= v.byteLength) {
        let tag = v.getUint16(off + 8, true);
        const channels = v.getUint16(off + 10, true);
        const sampleRate = v.getUint32(off + 12, true);
        const bitDepth = v.getUint16(off + 22, true);
        if (tag === 0xfffe && size >= 26 && off + 34 <= v.byteLength) tag = v.getUint16(off + 32, true); // EXTENSIBLE sub-format
        return { container: "wav", sampleRate, channels, bitDepth, float: tag === 3 };
      }
      off += 8 + size + (size % 2);
    }
    return unknown("wav");
  }
  if (v.byteLength >= 26 && ascii(v, 0, 4) === "fLaC") {
    // STREAMINFO: block header (4) then min/max block (4), min/max frame (6), then
    // sample rate (20 bits), channels-1 (3 bits), bits-1 (5 bits).
    const b = 8 + 10;
    const sampleRate = (v.getUint8(b) << 12) | (v.getUint8(b + 1) << 4) | (v.getUint8(b + 2) >> 4);
    const channels = ((v.getUint8(b + 2) >> 1) & 0x7) + 1;
    const bitDepth = (((v.getUint8(b + 2) & 0x1) << 4) | (v.getUint8(b + 3) >> 4)) + 1;
    return { container: "flac", sampleRate, channels, bitDepth, float: false };
  }
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ascii(v, 0, 3) === "ID3" || ext === "mp3") return { ...unknown("mp3"), ...mp3Header(v) };
  if (ascii(v, 4, 4) === "ftyp" || ext === "m4a" || ext === "aac" || ext === "mp4") return unknown("m4a");
  if (ascii(v, 0, 4) === "OggS" || ext === "ogg" || ext === "opus") return unknown("ogg");
  return unknown("other");
}

/** Sample rate and channels from the first MPEG audio frame header (after an ID3v2 tag, if any). */
function mp3Header(v: DataView): Partial<SourceFormat> {
  let off = 0;
  if (v.byteLength >= 10 && ascii(v, 0, 3) === "ID3") {
    const size = ((v.getUint8(6) & 0x7f) << 21) | ((v.getUint8(7) & 0x7f) << 14) | ((v.getUint8(8) & 0x7f) << 7) | (v.getUint8(9) & 0x7f);
    off = 10 + size;
  }
  const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  for (let i = off; i + 4 <= v.byteLength && i < off + 65536; i++) {
    const b1 = v.getUint8(i + 1);
    if (v.getUint8(i) !== 0xff || (b1 & 0xe0) !== 0xe0) continue;
    const version = (b1 >> 3) & 0x3;
    const rateIdx = (v.getUint8(i + 2) >> 2) & 0x3;
    const layer = (b1 >> 1) & 0x3;
    if (version === 1 || layer === 0 || rateIdx === 3) continue; // reserved values: not a real header
    return { sampleRate: RATES[version][rateIdx], channels: (v.getUint8(i + 3) >> 6) === 3 ? 1 : 2 };
  }
  return {};
}

/** The WAV the export should be written as, to match the source. */
export function exportSpec(format: SourceFormat, decodedRate: number): WavSpec {
  const sampleRate = decodedRate;
  if (format.container === "wav" && format.bitDepth) {
    if (format.float) return { sampleRate, bitDepth: 32, float: true };
    if (format.bitDepth <= 16) return { sampleRate, bitDepth: 16, float: false };
    if (format.bitDepth <= 24) return { sampleRate, bitDepth: 24, float: false };
    return { sampleRate, bitDepth: 32, float: false };
  }
  if (format.container === "flac" && format.bitDepth && format.bitDepth <= 16) return { sampleRate, bitDepth: 16, float: false };
  return { sampleRate, bitDepth: 24, float: false };
}

/** Rates Web Audio can decode at; anything else (or unknown) falls back to 44.1 kHz. */
export function decodeRateFor(format: SourceFormat): number {
  const r = format.sampleRate;
  return r && r >= 8000 && r <= 384000 ? r : 44100;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer> };

/**
 * Decodes at the file's NATIVE sample rate (no resampling for WAV/FLAC), keeps up to two channels
 * and builds the mono mix for analysis. The frame count equals the source's.
 */
export async function decodeTrack(bytes: ArrayBuffer, fileName = "", ctor?: OfflineCtor): Promise<DecodedTrack> {
  const format = sniffFormat(bytes, fileName);
  const OAC: OfflineCtor | undefined =
    ctor ??
    (typeof window !== "undefined"
      ? ((window.OfflineAudioContext ??
          (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext) as OfflineCtor | undefined)
      : undefined);
  if (!OAC) throw new Error("This browser cannot decode audio.");
  const rate = decodeRateFor(format);
  const buf = await new OAC(Math.min(2, format.channels ?? 2), 1, rate).decodeAudioData(bytes.slice(0));
  const n = Math.min(2, buf.numberOfChannels);
  const channels = Array.from({ length: n }, (_, c) => new Float32Array(buf.getChannelData(c)));
  const mono = n === 1 ? channels[0] : new Float32Array(channels[0].length);
  if (n === 2) {
    const [l, r] = channels;
    for (let i = 0; i < mono.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
  }
  return { channels, mono, sampleRate: buf.sampleRate, format };
}

/** Interleaved PCM WAV (16/24/32-bit int or 32-bit float), exactly `channels[0].length` frames. */
export function encodeWav(channels: readonly Float32Array[], spec: WavSpec): ArrayBuffer {
  const nch = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bps = spec.bitDepth / 8;
  const dataBytes = frames * nch * bps;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  put(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, spec.float ? 3 : 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, spec.sampleRate, true);
  v.setUint32(28, spec.sampleRate * nch * bps, true);
  v.setUint16(32, nch * bps, true);
  v.setUint16(34, spec.bitDepth, true);
  put(36, "data");
  v.setUint32(40, dataBytes, true);
  let off = 44;
  const clean = (x: number) => (Number.isFinite(x) ? x : 0);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = clean(channels[c][i]);
      if (spec.float) {
        v.setFloat32(off, x, true);
      } else {
        const s = Math.max(-1, Math.min(1, x));
        if (spec.bitDepth === 16) v.setInt16(off, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
        else if (spec.bitDepth === 24) {
          const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          v.setUint8(off, q & 0xff);
          v.setUint8(off + 1, (q >> 8) & 0xff);
          v.setUint8(off + 2, (q >> 16) & 0xff);
        } else v.setInt32(off, Math.round(s < 0 ? s * 0x80000000 : s * 0x7fffffff), true);
      }
      off += bps;
    }
  }
  return buf;
}

/** "Lead take.wav" -> "Lead take-autotuned.wav" */
export function autotunedName(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? "vocal").replace(/\.[^.]+$/, "") || "vocal";
  return `${base}-autotuned.wav`;
}
