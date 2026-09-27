import { beforeEach, describe, expect, it, vi } from "vitest";
import { MixEngine } from "./mixEngine";

/** Minimal AudioBuffer stand-in backed by real Float32Arrays, so sample math can be checked exactly. */
class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number, fill?: (c: number, i: number) => number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, (_, c) => {
      const arr = new Float32Array(length);
      if (fill) for (let i = 0; i < length; i++) arr[i] = fill(c, i);
      return arr;
    });
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.data[c];
  }
}

class FakeParam {
  value = 1;
  linearRampToValueAtTime = vi.fn();
  setValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeCtx {
  currentTime = 0;
  state = "running";
  destination = {};
  resume = vi.fn();
  /** url -> buffer the fake fetch/decode returns */
  sources = new Map<string, FakeBuffer>();
  decodeCount = 0;
  createGain() {
    return { gain: new FakeParam(), connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode;
  }
  createBufferSource() {
    return { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as AudioBufferSourceNode;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }
  decodeAudioData(ab: ArrayBuffer) {
    this.decodeCount++;
    const url = (ab as unknown as { __url: string }).__url;
    return Promise.resolve(this.sources.get(url) as unknown as AudioBuffer);
  }
}

const LEN = 64;
const RATE = 1000;
// Deterministic, distinct signals per stem (stereo).
const sig = (seed: number) => (c: number, i: number) => Math.sin((i + 1) * 0.37 * seed + c * 0.5) * 0.25;

describe("MixEngine derived tracks", () => {
  let ctx: FakeCtx;
  let engine: MixEngine;

  beforeEach(() => {
    ctx = new FakeCtx();
    ctx.sources.set("mix.wav", new FakeBuffer(2, LEN, RATE, sig(1)));
    ctx.sources.set("vocals.flac", new FakeBuffer(2, LEN, RATE, sig(2)));
    ctx.sources.set("drums.flac", new FakeBuffer(2, LEN, RATE, sig(3)));
    ctx.sources.set("drums.2.flac", new FakeBuffer(2, LEN, RATE, sig(5)));
    globalThis.fetch = vi.fn(async (url: string) => ({ arrayBuffer: async () => ({ __url: url }) as unknown as ArrayBuffer })) as unknown as typeof fetch;
    engine = new MixEngine(() => ctx as unknown as AudioContext);
  });

  it("builds other = mix * mixGain - (vocals + drums) sample-exactly, without playing the hidden mix", async () => {
    const mixGain = 0.8;
    await engine.load([
      { id: "vocals", url: "vocals.flac" },
      { id: "drums", url: "drums.flac" },
      { id: "other", derive: { plus: ["mix"], minus: ["vocals", "drums"], mixGain } },
      { id: "mix", url: "mix.wav", hidden: true },
    ]);
    const other = engine.bufferFor("other")!;
    expect(other).toBeTruthy();
    expect(other.length).toBe(LEN);
    expect(other.numberOfChannels).toBe(2);
    const mix = ctx.sources.get("mix.wav")!;
    const v = ctx.sources.get("vocals.flac")!;
    const d = ctx.sources.get("drums.flac")!;
    for (let c = 0; c < 2; c++) {
      const out = other.getChannelData(c);
      for (let i = 0; i < LEN; i++) {
        const expected = Math.fround(mix.getChannelData(c)[i] * mixGain - v.getChannelData(c)[i] - d.getChannelData(c)[i]);
        expect(out[i]).toBeCloseTo(expected, 6);
      }
    }
    // Stored stems + derived other sum back to mixGain * mix.
    for (let i = 0; i < LEN; i++) {
      const sum = other.getChannelData(0)[i] + v.getChannelData(0)[i] + d.getChannelData(0)[i];
      expect(sum).toBeCloseTo(mix.getChannelData(0)[i] * mixGain, 5);
    }

    engine.play(0);
    const sources = (engine as unknown as { sources: Map<string, unknown> }).sources;
    expect(Array.from(sources.keys()).sort()).toEqual(["drums", "other", "vocals"]);
  });

  it("reuses the derived buffer while inputs are unchanged and rebuilds it when an input url changes", async () => {
    const defs = (drumsUrl: string) => [
      { id: "vocals", url: "vocals.flac" },
      { id: "drums", url: drumsUrl },
      { id: "other", derive: { plus: ["mix"], minus: ["vocals", "drums"], mixGain: 1 } },
      { id: "mix", url: "mix.wav", hidden: true },
    ];
    await engine.load(defs("drums.flac"));
    const first = engine.bufferFor("other");
    await engine.load(defs("drums.flac"));
    expect(engine.bufferFor("other")).toBe(first);
    expect(ctx.decodeCount).toBe(3); // decoded once each, then cached

    // Enhance wrote a new drums file (new versioned url): other must be recomputed from it.
    await engine.load(defs("drums.2.flac"));
    const second = engine.bufferFor("other")!;
    expect(second).not.toBe(first);
    const mix = ctx.sources.get("mix.wav")!;
    const v = ctx.sources.get("vocals.flac")!;
    const d2 = ctx.sources.get("drums.2.flac")!;
    expect(second.getChannelData(1)[10]).toBeCloseTo(mix.getChannelData(1)[10] - v.getChannelData(1)[10] - d2.getChannelData(1)[10], 6);
  });

  it("rebuilds after forget() re-decodes an input, and skips a derived track whose input is missing", async () => {
    const defs = [
      { id: "vocals", url: "vocals.flac" },
      { id: "backing", derive: { plus: ["vocals"], minus: ["lead"] } },
    ];
    await engine.load(defs);
    expect(engine.bufferFor("backing")).toBeNull(); // "lead" isn't loaded

    const full = [
      { id: "vocals", url: "vocals.flac" },
      { id: "lead", url: "drums.flac" },
      { id: "backing", derive: { plus: ["vocals"], minus: ["lead"] } },
    ];
    await engine.load(full);
    const first = engine.bufferFor("backing");
    expect(first).toBeTruthy();
    engine.forget("vocals.flac");
    await engine.load(full);
    expect(engine.bufferFor("backing")).not.toBe(first);
  });
});
