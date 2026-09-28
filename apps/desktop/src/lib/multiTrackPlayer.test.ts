import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiTrackPlayer, effectiveGain, type MultiTrackPlayer } from "./multiTrackPlayer";

class FakeParam {
  value = 1;
  linearRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  setValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}
class FakeGain {
  gain = new FakeParam();
  connect = vi.fn((n: unknown) => n);
  disconnect = vi.fn();
}
class FakeBuffer {
  data: Float32Array[];
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  copyToChannel(src: Float32Array, ch: number, start = 0) {
    this.data[ch].set(src, start);
  }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn((n: unknown) => n);
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class FakeCtx {
  currentTime = 100;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  resume = vi.fn();
  close = vi.fn();
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBuffer(c: number, l: number, r: number) {
    return new FakeBuffer(c, l, r);
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const SR = 1000;
const ch = (n: number, v = 0.5) => new Float32Array(n).fill(v);

describe("effectiveGain (mute/solo rules)", () => {
  it("mute always silences; any solo silences the non-soloed", () => {
    expect(effectiveGain({ volume: 0.8, muted: false, solo: false }, false)).toBe(0.8);
    expect(effectiveGain({ volume: 0.8, muted: true, solo: false }, false)).toBe(0);
    expect(effectiveGain({ volume: 0.8, muted: false, solo: false }, true)).toBe(0);
    expect(effectiveGain({ volume: 0.8, muted: false, solo: true }, true)).toBe(0.8);
    expect(effectiveGain({ volume: 0.8, muted: true, solo: true }, true)).toBe(0);
  });
});

describe("MultiTrackPlayer", () => {
  let ctx: FakeCtx;
  let p: MultiTrackPlayer;
  beforeEach(() => {
    ctx = new FakeCtx();
    p = createMultiTrackPlayer(() => ctx as unknown as AudioContext);
    p.addTrack("lead", [ch(4000), ch(4000)], SR);
    p.addTrack("h1", [ch(3000)], SR, { offsetSec: 1 });
    p.addTrack("h2", [ch(4000), ch(4000)], SR);
  });

  it("starts every track at the same instant on one clock (offsets respected)", () => {
    p.play();
    const starts = ctx.sources.map((s) => s.start.mock.calls[0]);
    expect(starts).toHaveLength(3);
    const [lead, h1, h2] = starts;
    expect(lead[0]).toBeCloseTo(100.03, 6);
    expect(h2[0]).toBe(lead[0]); // identical scheduled start
    expect(h1[0]).toBeCloseTo(lead[0] + 1, 6); // offset track enters 1 s later on the same clock
    expect(lead[1]).toBe(0);
    expect(h1[1]).toBe(0);
  });

  it("seeking into an offset track starts it at the right local position", () => {
    p.seek(2.5);
    p.play();
    const h1 = ctx.sources.find((s) => s.buffer!.numberOfChannels === 1)!;
    expect(h1.start.mock.calls[0][1]).toBeCloseTo(1.5, 6);
  });

  it("duration is the end of the latest track", () => {
    expect(p.duration()).toBeCloseTo(4, 6); // h1: 1 s offset + 3 s
  });

  it("mute and solo glide the per-track gains (DAW rules)", () => {
    // gains[0] = master; then one gain per track in add order: lead, h1, h2.
    const level = (i: number) => ctx.gains[i + 1].gain.value;
    p.setSolo("h1", true);
    expect([level(0), level(1), level(2)]).toEqual([0, 1, 0]);
    p.setSolo("h2", true);
    expect([level(0), level(1), level(2)]).toEqual([0, 1, 1]);
    p.setMuted("h2", true);
    expect([level(0), level(1), level(2)]).toEqual([0, 1, 0]);
    p.setSolo("h1", false);
    p.setSolo("h2", false);
    p.setVolume("lead", 0.5);
    expect([level(0), level(1), level(2)]).toEqual([0.5, 1, 0]);
    // changes are glides anchored at the current value, never jumps
    expect(ctx.gains[1].gain.setValueAtTime).toHaveBeenCalled();
  });

  it("an edit patch restarts only that track, crossfaded", async () => {
    p.play();
    const before = ctx.sources.length;
    p.patch("h2", 100, [ch(50, 0.9), ch(50, 0.9)]);
    p.patch("h2", 200, [ch(50, 0.9), ch(50, 0.9)]); // burst -> one restart
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.sources.length).toBe(before + 1);
    const newest = ctx.sources[ctx.sources.length - 1];
    expect(newest.buffer!.data[0][120]).toBeCloseTo(0.9);
    const oldH2 = ctx.sources[2];
    expect(oldH2.stop).toHaveBeenCalled();
    expect(oldH2.stop.mock.calls[0][0]).toBeGreaterThan(ctx.currentTime); // faded, not cut
  });

  it("pause stops every voice and remembers the position; A/B switches all tracks", () => {
    p.play();
    ctx.currentTime = 101.53; // 1.5 s after the scheduled start
    p.pause();
    expect(p.isPlaying()).toBe(false);
    expect(p.currentTime()).toBeCloseTo(1.5, 5);
    p.play();
    const n = ctx.sources.length;
    p.setSource("original");
    expect(ctx.sources.length).toBe(n + 3);
    expect(p.getSource()).toBe("original");
  });

  it("audition plays one track without moving the playhead", () => {
    p.seek(0.7);
    p.audition("h1", 1.5, 2.0);
    const s = ctx.sources[ctx.sources.length - 1];
    expect(s.start.mock.calls[0][1]).toBeCloseTo(0.5, 6); // h1-local seconds
    expect(p.currentTime()).toBeCloseTo(0.7, 6);
  });

  it("removeTrack frees it and addTrack while playing joins in sync", () => {
    p.play();
    p.removeTrack("h2");
    expect(p.tracks().map((t) => t.id)).toEqual(["lead", "h1"]);
    ctx.currentTime = 100.53;
    p.addTrack("h3", [ch(4000)], SR);
    const s = ctx.sources[ctx.sources.length - 1];
    expect(s.start.mock.calls[0][0]).toBeCloseTo(100.56, 6);
    expect(s.start.mock.calls[0][1]).toBeCloseTo(0.53, 6);
  });
});

describe("MultiTrackPlayer guide tone and studio polish", () => {
  let ctx: FakeCtx;
  let p: MultiTrackPlayer;
  beforeEach(() => {
    ctx = new FakeCtx();
    p = createMultiTrackPlayer(() => ctx as unknown as AudioContext);
    p.addTrack("lead", [ch(4000)], SR);
    p.addTrack("h1", [ch(4000)], SR);
  });

  it("the guide plays with everything, ignores solo, and is not a track", () => {
    p.setGuide(ch(9000, 0.1), SR, 0);
    expect(p.hasGuide()).toBe(true);
    expect(p.tracks().map((t) => t.id)).toEqual(["lead", "h1"]);
    expect(p.duration()).toBe(4); // the longer guide does not stretch the song
    p.setSolo("h1", true);
    const guideGain = ctx.gains[ctx.gains.length - 1];
    expect(guideGain.gain.value).toBeCloseTo(0.35);
    p.play();
    expect(ctx.sources).toHaveLength(3);
    p.setGuide(null);
    expect(p.hasGuide()).toBe(false);
  });

  it("polish is skipped cleanly on a context without filters (and remembers the setting)", () => {
    p.setPolish(true);
    expect(p.getPolish()).toBe(true);
    p.play();
    expect(ctx.sources).toHaveLength(2);
  });
});
