import { describe, expect, it, vi } from "vitest";
import { buildPolish, plateImpulse, renderPolished, supportsPolish } from "./vocalPolish";

class Param {
  value = 0;
}
class Node {
  connect = vi.fn((n: unknown) => n);
  disconnect = vi.fn();
}
class Filter extends Node {
  type = "";
  frequency = new Param();
  Q = new Param();
  gain = new Param();
}
class Comp extends Node {
  threshold = new Param();
  knee = new Param();
  ratio = new Param();
  attack = new Param();
  release = new Param();
}
class Buf {
  data: Float32Array[];
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number) {
    return this.data[c];
  }
  copyToChannel(src: Float32Array, c: number) {
    this.data[c].set(src);
  }
}
class Ctx {
  sampleRate = 8000;
  destination = new Node();
  filters: Filter[] = [];
  createGain = () => Object.assign(new Node(), { gain: new Param() });
  createBiquadFilter = () => {
    const f = new Filter();
    this.filters.push(f);
    return f;
  };
  createDynamicsCompressor = () => new Comp();
  createConvolver = () => Object.assign(new Node(), { buffer: null as Buf | null });
  createBuffer = (c: number, l: number, r: number) => new Buf(c, l, r);
}

describe("vocalPolish", () => {
  it("builds the studio chain: rumble cut, mud cut, presence, air, compression, plate", () => {
    const ctx = new Ctx();
    expect(supportsPolish(ctx)).toBe(true);
    expect(supportsPolish({})).toBe(false);
    const chain = buildPolish(ctx as unknown as BaseAudioContext);
    expect(chain.input).toBeDefined();
    expect(ctx.filters.map((f) => [f.type, f.frequency.value, f.gain.value])).toEqual([
      ["highpass", 85, 0],
      ["peaking", 300, -2.5],
      ["peaking", 3200, 2],
      ["highshelf", 11000, 2.5],
    ]);
  });

  it("the plate impulse is deterministic, starts after a pre-delay and decays", () => {
    const a = plateImpulse(new Ctx() as unknown as BaseAudioContext, 1, 0.02) as unknown as Buf;
    const b = plateImpulse(new Ctx() as unknown as BaseAudioContext, 1, 0.02) as unknown as Buf;
    expect(a.data[0]).toEqual(b.data[0]);
    expect(Math.max(...a.data[0].subarray(0, 160).map(Math.abs))).toBe(0);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(a.data[0].subarray(200, 1200))).toBeGreaterThan(5 * rms(a.data[0].subarray(6000, 7000)));
    expect(a.data[0]).not.toEqual(a.data[1]); // decorrelated L/R = width
  });

  it("renderPolished keeps channel count and the exact length", async () => {
    class Offline extends Ctx {
      constructor(public channels: number, public length: number, rate: number) {
        super();
        this.sampleRate = rate;
      }
      createBufferSource = () => Object.assign(new Node(), { buffer: null, start: vi.fn() });
      startRendering = async () => {
        const out = new Buf(this.channels, this.length + 5, this.sampleRate);
        out.data.forEach((d) => d.fill(0.25));
        return out;
      };
    }
    const chs = [new Float32Array(1234), new Float32Array(1234)];
    const out = await renderPolished(chs, 48000, Offline as unknown as new (c: number, l: number, r: number) => OfflineAudioContext);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.length === 1234 && c[0] === 0.25)).toBe(true);
    // No offline audio (e.g. tests without Web Audio): returned unchanged.
    expect(await renderPolished(chs, 48000, undefined)).toBe(chs);
  });
});
