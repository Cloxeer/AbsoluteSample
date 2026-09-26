import { beforeEach, describe, expect, it, vi } from "vitest";
import { MixEngine } from "./mixEngine";

class FakeParam {
  value = 1;
  linearRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  setValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeGainNode {
  gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeSourceNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state: "running" | "suspended" = "running";
  destination = {};
  resume = vi.fn();
  createGain() {
    return new FakeGainNode() as unknown as GainNode;
  }
  createBufferSource() {
    return new FakeSourceNode() as unknown as AudioBufferSourceNode;
  }
  decodeAudioData(arrayBuffer: ArrayBuffer) {
    // The fake fetch below stashes the intended duration on the buffer itself.
    const duration = (arrayBuffer as unknown as { __duration: number }).__duration ?? 1;
    return Promise.resolve({ duration } as AudioBuffer);
  }
}

function fakeFetch(durationByUrl: Record<string, number>) {
  return vi.fn(async (url: string) => ({
    arrayBuffer: async () => ({ __duration: durationByUrl[url] ?? 1 }) as unknown as ArrayBuffer,
  })) as unknown as typeof fetch;
}

describe("MixEngine", () => {
  let ctx: FakeAudioContext;
  let engine: MixEngine;

  beforeEach(() => {
    ctx = new FakeAudioContext();
    engine = new MixEngine(() => ctx as unknown as AudioContext);
  });

  it("starts all sources at the identical computed start time", async () => {
    globalThis.fetch = fakeFetch({ "a.wav": 3, "b.wav": 5 });
    await engine.load([
      { id: "a", url: "a.wav" },
      { id: "b", url: "b.wav" },
    ]);
    ctx.currentTime = 10;
    engine.play(0);

    const srcA = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("a")!;
    const srcB = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("b")!;
    expect(srcA.start).toHaveBeenCalledTimes(1);
    expect(srcB.start).toHaveBeenCalledTimes(1);
    const [whenA, offsetA] = srcA.start.mock.calls[0];
    const [whenB, offsetB] = srcB.start.mock.calls[0];
    expect(whenA).toBeCloseTo(10.05, 5);
    expect(whenB).toBeCloseTo(10.05, 5);
    expect(whenA).toBe(whenB);
    expect(offsetA).toBe(0);
    expect(offsetB).toBe(0);
  });

  it("ignores a stale load() superseded by a newer one", async () => {
    const deferred: { resolve: (() => void) | undefined } = { resolve: undefined };
    globalThis.fetch = vi.fn((url: string) => {
      if (url === "slow.wav") {
        return new Promise((resolve) => {
          deferred.resolve = () =>
            resolve({ arrayBuffer: async () => ({ __duration: 1 }) as unknown as ArrayBuffer } as Response);
        });
      }
      return Promise.resolve({ arrayBuffer: async () => ({ __duration: 9 }) as unknown as ArrayBuffer } as Response);
    }) as unknown as typeof fetch;

    const firstLoad = engine.load([{ id: "a", url: "slow.wav" }]);
    await engine.load([{ id: "a", url: "fast.wav" }]);
    deferred.resolve?.();
    await firstLoad;

    ctx.currentTime = 0;
    engine.play(0);
    const src = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("a")!;
    expect(src.buffer?.duration).toBe(9);
  });

  it("setGain and setMaster ramp the corresponding gain node to the requested value", async () => {
    globalThis.fetch = fakeFetch({ "a.wav": 3 });
    await engine.load([{ id: "a", url: "a.wav" }]);
    engine.setGain("a", 0.4);
    engine.setMaster(0.7);

    const gainA = (engine as unknown as { gains: Map<string, FakeGainNode> }).gains.get("a")!;
    const master = (engine as unknown as { masterGain: FakeGainNode }).masterGain;
    expect(gainA.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.4, expect.any(Number));
    expect(master.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.7, expect.any(Number));
  });

  it("seek computes the correct offset while playing and while paused", async () => {
    globalThis.fetch = fakeFetch({ "a.wav": 10 });
    await engine.load([{ id: "a", url: "a.wav" }]);

    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 2.05; // 2s of playback elapsed since the 0.05s scheduled start
    engine.seek(4);
    ctx.currentTime += 0.05; // advance past the new scheduled start
    expect(engine.currentTime()).toBeCloseTo(4, 5);

    engine.pause();
    engine.seek(6);
    expect(engine.currentTime()).toBe(6);
    expect(engine.isPlaying).toBe(false);
  });

  it("restarts at 0 when the longest track's source ends and loop is enabled", async () => {
    globalThis.fetch = fakeFetch({ short: 3, long: 5 });
    await engine.load([
      { id: "short", url: "short" },
      { id: "long", url: "long" },
    ]);
    engine.setLoop(true);
    const onEnded = vi.fn();
    engine.onEnded(onEnded);

    ctx.currentTime = 0;
    engine.play(0);
    const longSrc = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("long")!;
    expect(longSrc.onended).toBeTruthy();

    ctx.currentTime = 5.05;
    longSrc.onended?.();
    ctx.currentTime += 0.05; // advance past the loop restart's scheduled start

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(true);
    expect(engine.currentTime()).toBeCloseTo(0, 5);
  });

  it("stops and reports not-playing when the longest track ends without loop", async () => {
    globalThis.fetch = fakeFetch({ a: 4 });
    await engine.load([{ id: "a", url: "a" }]);
    engine.play(0);
    const src = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("a")!;
    src.onended?.();
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime()).toBe(0);
  });

  it("never hard-cuts: pause fades out and stops slightly later; gain changes are anchored glides", async () => {
    globalThis.fetch = fakeFetch({ "a.wav": 4 });
    await engine.load([{ id: "a", url: "a.wav" }]);
    ctx.currentTime = 1;
    engine.play(0);
    const src = (engine as unknown as { sources: Map<string, FakeSourceNode> }).sources.get("a")!;
    const env = (engine as unknown as { envelopes: Map<string, FakeGainNode> }).envelopes.get("a")!;
    // fade in from silence at the start time
    expect(env.gain.setValueAtTime).toHaveBeenCalledWith(0, expect.closeTo(1.05, 5));
    ctx.currentTime = 2;
    engine.pause();
    const [when] = src.stop.mock.calls[0];
    expect(when).toBeGreaterThan(2); // stops after the fade-out, not instantly
    expect(env.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, expect.closeTo(2.008, 5));

    engine.setGain("a", 0.5);
    const g = (engine as unknown as { gains: Map<string, FakeGainNode> }).gains.get("a")!;
    expect(g.gain.setValueAtTime).toHaveBeenCalled(); // anchored at the current value first
    expect(g.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0.5, expect.closeTo(2.02, 5));
  });
});
