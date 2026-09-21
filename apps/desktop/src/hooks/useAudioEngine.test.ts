import { describe, expect, it } from "vitest";
import { sessionToState } from "./useAudioEngine";
import type { LoopAnalysis, LoopInfo, StemInfo, TrackInfo, TrackSession } from "@/lib/types";

const track: TrackInfo = {
  id: "abc12345678",
  title: "Test track",
  url: "https://youtu.be/abc12345678",
  sourcePath: "source.opus",
  wavPath: "source.wav",
  durationSec: 120,
  sampleRate: 44100,
  channels: 2,
  codec: "opus",
  workDir: "workdir",
};

const loop: LoopInfo = {
  trackId: track.id,
  startSec: 10,
  endSec: 25,
  durationSec: 15,
  loopPath: "loop.opus",
  wavPath: "loop.wav",
};

const stems: StemInfo[] = [
  { index: 1, key: "drums_sub", label: "Drums / Sub", band: "LP 130 Hz", path: "s1.wav", bytes: 1, peakDb: -1, rmsDb: -1 },
];

const analysis: LoopAnalysis = {
  bpm: 120,
  confidence: 0.9,
  transients: [],
  beatGrid: [],
  bars: 4,
  onsetEnvelope: [],
  peakDb: -1,
  rmsDb: -10,
};

describe("sessionToState", () => {
  it("maps to 'ready' when stems are present", () => {
    const session: TrackSession = { track, loop, stems, instruments: null, analysis };
    const result = sessionToState(session);
    expect(result.state).toBe("ready");
    expect(result.track).toBe(track);
    expect(result.stems).toBe(stems);
  });

  it("maps to 'ready' when instruments are present", () => {
    const session: TrackSession = {
      track,
      loop,
      stems: null,
      instruments: [
        { key: "vocals", label: "Vocals", group: "vocals", parent: null, path: "v.wav", bytes: 1, peakDb: -1, rmsDb: -1, model: "m", order: 0 },
      ],
      analysis,
    };
    const result = sessionToState(session);
    expect(result.state).toBe("ready");
  });

  it("maps to 'trimmed' when only a loop exists", () => {
    const session: TrackSession = { track, loop, stems: null, instruments: null, analysis: null };
    const result = sessionToState(session);
    expect(result.state).toBe("trimmed");
    expect(result.loop).toBe(loop);
  });

  it("maps to 'fetched' when there is no loop and no split", () => {
    const session: TrackSession = { track, loop: null, stems: null, instruments: null, analysis: null };
    const result = sessionToState(session);
    expect(result.state).toBe("fetched");
  });
});
