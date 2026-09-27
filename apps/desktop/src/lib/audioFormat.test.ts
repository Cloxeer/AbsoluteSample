import { describe, expect, it } from "vitest";
import { autotunedName, decodeRateFor, decodeTrack, encodeWav, exportSpec, sniffFormat, type WavSpec } from "./audioFormat";

/** Reads frames back from a WAV written by encodeWav (int 16/24/32 or float 32). */
function readWav(buf: ArrayBuffer): { channels: Float32Array[]; rate: number; bits: number; float: boolean } {
  const v = new DataView(buf);
  const nch = v.getUint16(22, true);
  const rate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const float = v.getUint16(20, true) === 3;
  const bps = bits / 8;
  const frames = v.getUint32(40, true) / (nch * bps);
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  let off = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++, off += bps) {
      let x: number;
      if (float) x = v.getFloat32(off, true);
      else if (bits === 16) x = v.getInt16(off, true) / 0x8000;
      else if (bits === 24) x = ((v.getUint8(off) | (v.getUint8(off + 1) << 8) | (v.getInt8(off + 2) << 16))) / 0x800000;
      else x = v.getInt32(off, true) / 0x80000000;
      channels[c][i] = x;
    }
  return { channels, rate, bits, float };
}

const tone = (n: number, f: number, sr: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

describe("audioFormat", () => {
  it.each<[WavSpec, number]>([
    [{ sampleRate: 44100, bitDepth: 16, float: false }, 1 / 0x7fff],
    [{ sampleRate: 48000, bitDepth: 24, float: false }, 1 / 0x7fffff],
    [{ sampleRate: 96000, bitDepth: 32, float: true }, 1e-7],
  ])("encodeWav keeps exact length, channels, rate and values (%o)", (spec, tol) => {
    const l = tone(12345, 440, spec.sampleRate);
    const r = tone(12345, 660, spec.sampleRate, 0.3);
    const back = readWav(encodeWav([l, r], spec));
    expect(back.rate).toBe(spec.sampleRate);
    expect(back.bits).toBe(spec.bitDepth);
    expect(back.channels).toHaveLength(2);
    expect(back.channels[0]).toHaveLength(12345);
    const err = Math.max(...back.channels[0].map((x, i) => Math.abs(x - l[i])), ...back.channels[1].map((x, i) => Math.abs(x - r[i])));
    expect(err).toBeLessThanOrEqual(tol * 1.01);
  });

  it("encodeWav writes mono when given one channel and never NaN", () => {
    const x = new Float32Array([0, 1, -1, NaN, 2]);
    const back = readWav(encodeWav([x], { sampleRate: 44100, bitDepth: 16, float: false }));
    expect(back.channels).toHaveLength(1);
    expect(Array.from(back.channels[0]).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1, -1, 0, 1]);
  });

  it("sniffs WAV rate/channels/bits including float", () => {
    const f = sniffFormat(encodeWav([tone(10, 1, 48000), tone(10, 1, 48000)], { sampleRate: 48000, bitDepth: 24, float: false }));
    expect(f).toEqual({ container: "wav", sampleRate: 48000, channels: 2, bitDepth: 24, float: false });
    const g = sniffFormat(encodeWav([tone(10, 1, 44100)], { sampleRate: 44100, bitDepth: 32, float: true }));
    expect(g.float).toBe(true);
    expect(g.channels).toBe(1);
  });

  it("sniffs FLAC STREAMINFO", () => {
    // fLaC + STREAMINFO header (type 0, len 34): 96 kHz, 2 channels, 24-bit.
    const b = new Uint8Array(42);
    b.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22], 0);
    const rate = 96000, ch = 2, bits = 24;
    const o = 18;
    b[o] = (rate >> 12) & 0xff;
    b[o + 1] = (rate >> 4) & 0xff;
    b[o + 2] = ((rate & 0xf) << 4) | (((ch - 1) & 0x7) << 1) | (((bits - 1) >> 4) & 0x1);
    b[o + 3] = ((bits - 1) & 0xf) << 4;
    expect(sniffFormat(b.buffer)).toEqual({ container: "flac", sampleRate: 96000, channels: 2, bitDepth: 24, float: false });
  });

  it("reads the MP3 sample rate and channels from the first frame (after ID3)", () => {
    const b = new Uint8Array(40);
    b.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10], 0); // ID3v2, 10-byte body
    b.set([0xff, 0xfb, 0x94, 0x00], 20); // MPEG1 Layer III, rate index 1 (48 kHz), stereo
    expect(sniffFormat(b.buffer)).toMatchObject({ container: "mp3", sampleRate: 48000, channels: 2 });
    const mono = new Uint8Array(8);
    mono.set([0xff, 0xf3, 0x88, 0xc0], 0); // MPEG2 Layer III, rate index 2 (16 kHz), mono
    expect(sniffFormat(mono.buffer, "x.mp3")).toMatchObject({ sampleRate: 16000, channels: 1 });
  });

  it("recognises compressed containers and picks sensible export specs", () => {
    expect(sniffFormat(new TextEncoder().encode("ID3xxxxxxxxxxxxx").buffer as ArrayBuffer).container).toBe("mp3");
    expect(sniffFormat(new ArrayBuffer(16), "take.m4a").container).toBe("m4a");
    expect(exportSpec({ container: "mp3", sampleRate: null, channels: null, bitDepth: null, float: false }, 48000)).toEqual({ sampleRate: 48000, bitDepth: 24, float: false });
    expect(exportSpec({ container: "wav", sampleRate: 44100, channels: 2, bitDepth: 16, float: false }, 44100).bitDepth).toBe(16);
    expect(exportSpec({ container: "wav", sampleRate: 44100, channels: 2, bitDepth: 32, float: true }, 44100)).toEqual({ sampleRate: 44100, bitDepth: 32, float: true });
    expect(decodeRateFor({ container: "wav", sampleRate: 48000, channels: 2, bitDepth: 24, float: false })).toBe(48000);
    expect(decodeRateFor({ container: "mp3", sampleRate: null, channels: null, bitDepth: null, float: false })).toBe(44100);
  });

  it("decodeTrack decodes at the native rate, keeps stereo and averages the mono mix", async () => {
    const created: number[] = [];
    class FakeCtx {
      constructor(_c: number, _l: number, rate: number) {
        created.push(rate);
      }
      async decodeAudioData(): Promise<AudioBuffer> {
        const l = Float32Array.from([1, 0.5, 0]);
        const r = Float32Array.from([0, 0.5, 1]);
        return { numberOfChannels: 2, sampleRate: created[0], getChannelData: (c: number) => (c === 0 ? l : r) } as unknown as AudioBuffer;
      }
    }
    const bytes = encodeWav([tone(3, 1, 48000), tone(3, 1, 48000)], { sampleRate: 48000, bitDepth: 24, float: false });
    const t = await decodeTrack(bytes, "x.wav", FakeCtx);
    expect(created).toEqual([48000]);
    expect(t.sampleRate).toBe(48000);
    expect(t.channels).toHaveLength(2);
    expect(Array.from(t.mono)).toEqual([0.5, 0.5, 0.5]);
  });

  it("names exports <name>-autotuned.wav", () => {
    expect(autotunedName("C:\\takes\\Harmony 2.flac")).toBe("Harmony 2-autotuned.wav");
    expect(autotunedName("lead.wav")).toBe("lead-autotuned.wav");
  });
});
