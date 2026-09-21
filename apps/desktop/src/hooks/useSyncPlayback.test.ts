import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  computeGains,
  nextTransportState,
  useSyncPlayback,
  type TrackGainState,
  type TransportState,
  type WaveSurferLike,
} from "./useSyncPlayback";

vi.mock("@/lib/mixEngine", () => ({
  mixEngine: {
    load: vi.fn(() => Promise.resolve()),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    setGain: vi.fn(),
    setMaster: vi.fn(),
    setLoop: vi.fn(),
    onEnded: vi.fn(),
    currentTime: vi.fn(() => 0),
    isPlaying: false,
  },
}));

vi.mock("@/lib/samplePlayer", () => ({
  samplePlayer: { stop: vi.fn() },
}));

describe("computeGains", () => {
  it("returns each track's own volume when nothing is soloed or muted", () => {
    const tracks: TrackGainState[] = [
      { id: "a", volume: 1, solo: false, mute: false },
      { id: "b", volume: 0.5, solo: false, mute: false },
    ];
    expect(computeGains(tracks)).toEqual({ a: 1, b: 0.5 });
  });

  it("mutes non-soloed tracks when one track is soloed", () => {
    const tracks: TrackGainState[] = [
      { id: "a", volume: 1, solo: true, mute: false },
      { id: "b", volume: 0.8, solo: false, mute: false },
      { id: "c", volume: 0.3, solo: false, mute: false },
    ];
    expect(computeGains(tracks)).toEqual({ a: 1, b: 0, c: 0 });
  });

  it("keeps multiple soloed tracks audible together", () => {
    const tracks: TrackGainState[] = [
      { id: "a", volume: 1, solo: true, mute: false },
      { id: "b", volume: 0.6, solo: true, mute: false },
      { id: "c", volume: 0.3, solo: false, mute: false },
    ];
    expect(computeGains(tracks)).toEqual({ a: 1, b: 0.6, c: 0 });
  });

  it("mute always wins over solo", () => {
    const tracks: TrackGainState[] = [
      { id: "a", volume: 1, solo: true, mute: true },
      { id: "b", volume: 0.5, solo: false, mute: false },
    ];
    expect(computeGains(tracks)).toEqual({ a: 0, b: 0 });
  });
});

describe("nextTransportState", () => {
  const initial: TransportState = { mode: "mix", auditionId: null, isPlaying: false };

  it("PLAY_MIX switches to mix mode and starts playback", () => {
    expect(nextTransportState(initial, { type: "PLAY_MIX" })).toEqual({
      mode: "mix",
      auditionId: null,
      isPlaying: true,
    });
  });

  it("STOP always resets to mix mode, no audition, stopped", () => {
    const auditioning: TransportState = { mode: "audition", auditionId: "drums_sub", isPlaying: true };
    expect(nextTransportState(auditioning, { type: "STOP" })).toEqual({
      mode: "mix",
      auditionId: null,
      isPlaying: false,
    });
  });

  it("PAUSE stops playback but keeps the current mode/audition target", () => {
    const auditioning: TransportState = { mode: "audition", auditionId: "bass_lowmid", isPlaying: true };
    expect(nextTransportState(auditioning, { type: "PAUSE" })).toEqual({
      mode: "audition",
      auditionId: "bass_lowmid",
      isPlaying: false,
    });
  });

  it("AUDITION on a stopped transport starts auditioning that track", () => {
    expect(nextTransportState(initial, { type: "AUDITION", id: "drums_sub" })).toEqual({
      mode: "audition",
      auditionId: "drums_sub",
      isPlaying: true,
    });
  });

  it("AUDITION on a different track while one is already auditioning switches targets", () => {
    const auditioning: TransportState = { mode: "audition", auditionId: "drums_sub", isPlaying: true };
    expect(nextTransportState(auditioning, { type: "AUDITION", id: "bass_lowmid" })).toEqual({
      mode: "audition",
      auditionId: "bass_lowmid",
      isPlaying: true,
    });
  });

  it("AUDITION on the currently-playing auditioned track toggles it off", () => {
    const auditioning: TransportState = { mode: "audition", auditionId: "drums_sub", isPlaying: true };
    expect(nextTransportState(auditioning, { type: "AUDITION", id: "drums_sub" })).toEqual({
      mode: "mix",
      auditionId: null,
      isPlaying: false,
    });
  });

  it("AUDITION on a paused (not playing) auditioned track re-starts it rather than toggling off", () => {
    const paused: TransportState = { mode: "audition", auditionId: "drums_sub", isPlaying: false };
    expect(nextTransportState(paused, { type: "AUDITION", id: "drums_sub" })).toEqual({
      mode: "audition",
      auditionId: "drums_sub",
      isPlaying: true,
    });
  });
});

function fakeWs(): WaveSurferLike {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    setTime: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    setVolume: vi.fn(),
    isPlaying: vi.fn(() => false),
  };
}

describe("useSyncPlayback mix playback (routed through mixEngine)", () => {
  it("playMix loads every registered mix track then starts mixEngine, without ever calling ws.play()", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    const { samplePlayer } = await import("@/lib/samplePlayer");
    const { result } = renderHook(() => useSyncPlayback());

    const wsA = fakeWs();
    const wsB = fakeWs();
    act(() => {
      result.current.registerInstance("a", wsA, true, true, "a.wav");
      result.current.registerInstance("b", wsB, false, true, "b.wav");
    });

    await act(async () => {
      await result.current.playMix();
    });

    expect(samplePlayer.stop).toHaveBeenCalled();
    expect(mixEngine.load).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: "a", url: "a.wav" },
        { id: "b", url: "b.wav" },
      ])
    );
    expect(mixEngine.play).toHaveBeenCalled();
    expect(wsA.play).not.toHaveBeenCalled();
    expect(wsB.play).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);
  });

  it("pause routes through mixEngine.pause()", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    const { result } = renderHook(() => useSyncPlayback());

    act(() => result.current.pause());

    expect(mixEngine.pause).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it("stopAll stops mixEngine and resets every display instance's playhead to 0", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    const { result } = renderHook(() => useSyncPlayback());
    const ws = fakeWs();
    act(() => result.current.registerInstance("a", ws, true, true, "a.wav"));

    act(() => result.current.stopAll());

    expect(mixEngine.stop).toHaveBeenCalled();
    expect(ws.setTime).toHaveBeenCalledWith(0);
  });

  it("applyGains forwards computeGains' output to mixEngine.setGain per track", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    const { result } = renderHook(() => useSyncPlayback());

    act(() => {
      result.current.upsertTrack({ id: "a", volume: 1, solo: true, mute: false });
      result.current.upsertTrack({ id: "b", volume: 0.4, solo: false, mute: false });
    });

    expect(mixEngine.setGain).toHaveBeenCalledWith("a", 1);
    expect(mixEngine.setGain).toHaveBeenCalledWith("b", 0);
  });

  it("toggleLoop forwards the new value to mixEngine.setLoop", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    const { result } = renderHook(() => useSyncPlayback());

    act(() => result.current.toggleLoop());

    expect(mixEngine.setLoop).toHaveBeenCalledWith(true);
  });

  it("seeking while paused stores the position, and playMix then starts mix from that position", async () => {
    const { mixEngine } = await import("@/lib/mixEngine");
    (mixEngine.currentTime as ReturnType<typeof vi.fn>).mockReturnValue(0);
    const { result } = renderHook(() => useSyncPlayback());
    const ws = fakeWs();
    act(() => result.current.registerInstance("a", ws, true, true, "a.wav"));

    act(() => result.current.seek(12.5));

    // Paused: mixEngine.seek() is called (which itself just stores the position when not playing),
    // every registered lane's cursor is moved, and the master clock reflects the new position.
    expect(mixEngine.seek).toHaveBeenCalledWith(12.5);
    expect(ws.setTime).toHaveBeenCalledWith(12.5);
    expect(result.current.currentTime).toBe(12.5);

    // playMix should resume from the stored position, not from 0.
    (mixEngine.currentTime as ReturnType<typeof vi.fn>).mockReturnValue(12.5);
    await act(async () => {
      await result.current.playMix();
    });

    expect(mixEngine.play).toHaveBeenCalledWith(12.5);
  });
});
