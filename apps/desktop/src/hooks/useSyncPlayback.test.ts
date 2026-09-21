import { describe, expect, it } from "vitest";
import { computeGains, nextTransportState, type TrackGainState, type TransportState } from "./useSyncPlayback";

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
