import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesResult } from "./types";

vi.mock("./mixEngine", () => ({
  mixEngine: { isPlaying: false, pause: vi.fn() },
}));
vi.mock("./samplePlayer", () => ({
  samplePlayer: { stop: vi.fn() },
}));

class FakeParam {
  value = 1;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeGainNode {
  gain = new FakeParam();
  connect = vi.fn(() => this);
}

class FakeOscillatorNode {
  type = "sine";
  frequency = new FakeParam();
  connect = vi.fn((dest: unknown) => dest);
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
  createOscillator() {
    return new FakeOscillatorNode() as unknown as OscillatorNode;
  }
}

function makeResult(notes: NotesResult["notes"]): NotesResult {
  return {
    notes,
    key: null,
    chords: [],
    scale: [],
    bpm: null,
    midPath: "mock.mid",
    elapsedSec: 0,
  };
}

describe("notePlayer", () => {
  let ctx: FakeAudioContext;

  beforeEach(async () => {
    ctx = new FakeAudioContext();
    vi.resetModules();
  });

  async function freshPlayer() {
    const mod = await import("./notePlayer");
    // Swap in a fresh instance with the fake context factory, mirroring MixEngine's test pattern.
    const NotePlayerCtor = (mod as unknown as { notePlayer: { constructor: new (f: () => AudioContext) => unknown } })
      .notePlayer.constructor as new (f: () => AudioContext) => typeof mod.notePlayer;
    return new NotePlayerCtor(() => ctx as unknown as AudioContext);
  }

  it("schedules oscillators at offsets relative to fromSec, skipping notes that already ended", async () => {
    const player = await freshPlayer();
    const notes: NotesResult["notes"] = [
      { startSec: 0, endSec: 1, midi: 60, name: "C4", velocity: 100 },
      { startSec: 2, endSec: 3, midi: 64, name: "E4", velocity: 100 },
      { startSec: 5, endSec: 6, midi: 67, name: "G4", velocity: 100 },
    ];
    ctx.currentTime = 100;
    player.play(makeResult(notes), 2);

    const oscs = (player as unknown as { voices: { osc: FakeOscillatorNode }[] }).voices;
    // The first note (0-1s) ends before fromSec=2 and should be skipped entirely.
    expect(oscs.length).toBe(2);
    // Second note starts exactly at fromSec -> when = ctx.currentTime + 0
    expect(oscs[0].osc.start).toHaveBeenCalledWith(100);
    // Third note starts 3s after fromSec -> when = ctx.currentTime + 3
    expect(oscs[1].osc.start).toHaveBeenCalledWith(103);
  });

  it("pause/resume arithmetic: pause captures elapsed position, resume continues from there", async () => {
    const player = await freshPlayer();
    const notes: NotesResult["notes"] = [{ startSec: 0, endSec: 10, midi: 60, name: "C4", velocity: 100 }];
    const result = makeResult(notes);

    ctx.currentTime = 0;
    player.play(result, 0, "Test");
    ctx.currentTime = 3; // 3 seconds of playback elapsed

    player.pause();
    expect(player.currentTime()).toBe(3);
    expect(player.isPlaying).toBe(false);

    ctx.currentTime = 50; // time passes while paused; must not affect the stored position
    expect(player.currentTime()).toBe(3);

    player.resume();
    expect(player.isPlaying).toBe(true);
    // resume() re-plays from the paused position, so a new voice starts "now" for the remaining note
    const oscs = (player as unknown as { voices: { osc: FakeOscillatorNode }[] }).voices;
    expect(oscs.length).toBe(1);
    expect(oscs[0].osc.start).toHaveBeenCalledWith(50);

    ctx.currentTime = 52;
    expect(player.currentTime()).toBeCloseTo(5, 5);
  });

  it("stop() resets the position to 0", async () => {
    const player = await freshPlayer();
    const notes: NotesResult["notes"] = [{ startSec: 0, endSec: 10, midi: 60, name: "C4", velocity: 100 }];
    player.play(makeResult(notes), 4);
    player.stop();
    expect(player.isPlaying).toBe(false);
    expect(player.currentTime()).toBe(0);
  });
});
