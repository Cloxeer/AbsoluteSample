import { describe, expect, it } from "vitest";
import { computeGains, type TrackGainState } from "./useSyncPlayback";

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
