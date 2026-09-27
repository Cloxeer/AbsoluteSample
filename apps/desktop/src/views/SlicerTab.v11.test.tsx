import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SlicerTab } from "./SlicerTab";
import type { AudioEngineState, useAudioEngine } from "@/hooks/useAudioEngine";
import type { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { backend } from "@/lib/backend";
import { emitMockProgress } from "@/lib/events";
import type { InstrumentStem, LoopInfo, TrackInfo } from "@/lib/types";

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      setTime: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 15),
      setVolume: vi.fn(),
      isPlaying: vi.fn(() => false),
    })),
  },
}));

vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => ({
  default: { create: vi.fn(() => ({ on: vi.fn(), un: vi.fn(), enableDragSelection: vi.fn(), addRegion: vi.fn() })) },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

const track: TrackInfo = {
  id: "nRKgT3d6xoE",
  title: "Song",
  url: "https://youtu.be/nRKgT3d6xoE",
  sourcePath: "s.opus",
  wavPath: "s.wav",
  durationSec: 60,
  sampleRate: 44100,
  channels: 2,
  codec: "opus",
  workDir: "w",
};
const loop: LoopInfo = { trackId: track.id, startSec: 0, endSec: 15, durationSec: 15, loopPath: "l.opus", wavPath: "loop.wav" };

const vocals: InstrumentStem = {
  key: "vocals",
  label: "Vocals",
  group: "vocals",
  parent: null,
  path: "w/instruments/vocals.flac",
  bytes: 1,
  peakDb: -3,
  rmsDb: -18,
  model: "m",
  order: 0,
  peaks: [0.1, 0.5, 0.2],
  durationSec: 15,
};

const stubSync = {
  tracks: [],
  currentTime: 0,
  mode: "mix" as const,
  auditionId: null,
  upsertTrack: () => {},
  registerInstance: () => {},
  unregisterInstance: () => {},
  setSources: () => {},
  handleTimeUpdate: () => {},
  handleFinish: () => {},
  auditionTrack: () => {},
  seek: () => {},
  stopAll: () => {},
} as unknown as ReturnType<typeof useSyncPlayback>;

function fakeApi(engine: Partial<AudioEngineState>, overrides: Partial<ReturnType<typeof useAudioEngine>> = {}) {
  const state: AudioEngineState = {
    state: "trimmed",
    track,
    loop,
    stems: null,
    instruments: null,
    instrumentsMeta: null,
    partialInstruments: null,
    karaoke: null,
    karaokeMixPath: null,
    analysis: null,
    progress: null,
    error: null,
    ...engine,
  };
  const never = () => new Promise<never>(() => {});
  return {
    engine: state,
    fetchAudio: vi.fn(),
    importLocal: vi.fn(),
    trimLoop: vi.fn(),
    separateStems: vi.fn(),
    separateInstruments: vi.fn(never),
    separateKaraoke: vi.fn(never),
    enhanceRegion: vi.fn(),
    splitSubstems: vi.fn(),
    analyzeLoop: vi.fn(),
    reset: vi.fn(),
    openTrack: vi.fn(),
    newLink: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useAudioEngine>;
}

async function waitForEngineStatus() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

describe("SlicerTab v11", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plays early stems as normal lanes while the split runs, with a placeholder for the rest", async () => {
    const api = fakeApi({ state: "separating", partialInstruments: [vocals] });
    render(<SlicerTab engineApi={api} syncApi={stubSync} />);
    expect(await screen.findByRole("group", { name: "Vocals track" })).toBeInTheDocument();
    expect(screen.getByText("Separating instruments…")).toBeInTheDocument();
    expect(screen.getByLabelText("Play Vocals only")).toBeInTheDocument();
  });

  it("Split runs a quick split, and Run anyway on a busy PC sets low priority", async () => {
    vi.spyOn(backend, "systemLoad").mockResolvedValue({ ramTotalGb: 32, ramFreeGb: 20, gpuUtil: 90, verdict: "busy", reasons: ["The graphics card is busy"] });
    const api = fakeApi({});
    render(<SlicerTab engineApi={api} syncApi={stubSync} />);
    await waitForEngineStatus();
    expect(screen.getByText("Quick split: Enhance any part later")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Split"));
    expect(await screen.findByText("Your PC is busy")).toBeInTheDocument();
    expect(api.separateInstruments).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Run anyway (low priority)"));
    await waitFor(() => expect(api.separateInstruments).toHaveBeenCalledWith(track.id, { lowPriority: true, quality: "quick" }));
  });

  it("shows the Keep models loaded button when the engine is installed", async () => {
    render(<SlicerTab engineApi={fakeApi({})} syncApi={stubSync} />);
    expect(await screen.findByRole("button", { name: "Keep models loaded" })).toBeInTheDocument();
  });

  it("the karaoke checklist follows karaoke progress (stage 'karaoke')", async () => {
    const api = fakeApi({});
    render(<SlicerTab engineApi={api} syncApi={stubSync} />);
    await waitForEngineStatus();
    fireEvent.click(screen.getByText("Karaoke"));
    await waitFor(() => expect(api.separateKaraoke).toHaveBeenCalled());
    const vocalsRow = await waitFor(() => {
      const li = document.querySelector('li[data-pass="vocals"]');
      expect(li).not.toBeNull();
      return li!;
    });
    expect(vocalsRow.getAttribute("data-state")).toBe("pending");

    await act(async () => {
      emitMockProgress({ stage: "karaoke", pass: "vocals", percent: 40, message: "Separating", trackId: track.id });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('li[data-pass="vocals"]')!.getAttribute("data-state")).toBe("running"));

    await act(async () => {
      emitMockProgress({ stage: "karaoke", pass: "vocals", percent: 100, message: "done in 9.0s", trackId: track.id });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('li[data-pass="vocals"]')!.getAttribute("data-state")).toBe("done"));
  });
});
