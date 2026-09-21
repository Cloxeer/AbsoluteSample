import { beforeEach, describe, expect, it, vi } from "vitest";
import { samplePlayer } from "./samplePlayer";
import type { Sample } from "./types";

function makeSample(id: string): Sample {
  return {
    id,
    name: id,
    path: `mock/${id}.wav`,
    bytes: 1000,
    songId: "song1",
    songTitle: "Song",
    stemKey: "guitar",
    stemLabel: "Guitar",
    group: "guitar",
    startSec: 0,
    endSec: 1,
    durationSec: 1,
    bpm: null,
    createdAt: new Date().toISOString(),
  };
}

describe("samplePlayer singleton exclusivity", () => {
  beforeEach(() => {
    samplePlayer.stop();
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  it("stops sample A when sample B starts playing", () => {
    const a = makeSample("a");
    const b = makeSample("b");

    samplePlayer.play(a, "blob:a");
    expect(samplePlayer.getState().id).toBe("a");

    samplePlayer.play(b, "blob:b");
    expect(samplePlayer.getState().id).toBe("b");
    expect(samplePlayer.isPlaying("a")).toBe(false);
    expect(samplePlayer.isPlaying("b")).toBe(true);
  });

  it("stop() clears the current id", () => {
    const a = makeSample("a");
    samplePlayer.play(a, "blob:a");
    samplePlayer.stop();
    expect(samplePlayer.getState().id).toBeNull();
  });
});
