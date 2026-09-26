import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutotuneTab } from "./AutotuneTab";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import type { InstrumentStem, Sample, TrackInfo } from "@/lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      setTime: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 4.2),
      setVolume: vi.fn(),
      isPlaying: vi.fn(() => false),
    })),
  },
}));

const track: TrackInfo = {
  id: "t1",
  title: "Test Track",
  url: "https://youtu.be/xxxxxxxxxxx",
  sourcePath: "mock/t1/source.opus",
  wavPath: "mock/t1/source.wav",
  durationSec: 180,
  sampleRate: 44100,
  channels: 2,
  codec: "opus",
  workDir: "mock/t1",
};

const instruments: InstrumentStem[] = [
  {
    key: "vocals",
    label: "Vocals",
    group: "vocals",
    parent: null,
    path: "mock/t1/instruments/vocals.wav",
    bytes: 1000,
    peakDb: -2,
    rmsDb: -14,
    model: "htdemucs_6s",
    order: 0,
  },
  {
    key: "drums",
    label: "Drums",
    group: "drums",
    parent: null,
    path: "mock/t1/instruments/drums.wav",
    bytes: 1000,
    peakDb: -2,
    rmsDb: -14,
    model: "htdemucs_6s",
    order: 1,
  },
];

const samples: Sample[] = [];

function pickSongSource(label: RegExp | string) {
  fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), {
    target: { value: instruments.find((s) => new RegExp(label as string, "i").test(s.label))?.path ?? label },
  });
}

describe("AutotuneTab", () => {
  it("shows the empty state before analyzing", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    expect(screen.getByText(/drop your vocal or pick one from the song, then analyze/i)).toBeInTheDocument();
  });

  it("offers both a drop/choose-file zone and a from-song dropdown", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    expect(screen.getByTestId("autotune-dropzone")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: /vocal from this song/i });
    expect(select).toHaveTextContent("Vocals");
    expect(select).toHaveTextContent("Drums");
  });

  it("Analyze is disabled until a source is picked", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    expect(screen.getByRole("button", { name: /^analyze$/i })).toBeDisabled();
  });

  it("picking a stem from the song tags it 'From song' and enables Analyze", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), {
      target: { value: instruments[0].path },
    });
    expect(screen.getByText(/from song/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^analyze$/i })).not.toBeDisabled();
  });

  it("calls backend.analyzePitch for the selected song source and renders the editor", async () => {
    const spy = vi.spyOn(backend, "analyzePitch");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), {
      target: { value: instruments[0].path },
    });

    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ path: instruments[0].path }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());
    expect(screen.getByText(/in plain words/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeInTheDocument();
  });

  it("dropping the user's own file tags it 'Your file' and analyzes it directly", async () => {
    URL.createObjectURL = vi.fn(() => "blob:mock");
    const spy = vi.spyOn(backend, "analyzePitch");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake audio"], "my-vocal-take.wav", { type: "audio/wav" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    expect(screen.getByText("my-vocal-take.wav")).toBeInTheDocument();
    expect(screen.getByText(/your file/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ path: "my-vocal-take.wav" }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());
  });

  it("disables Apply-derived actions (compare tuned, save, download) until Apply runs", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /pause tuned|play tuned/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^save as sample$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^download$/i })).toBeDisabled();
  });

  it("applies edits and enables compare/save/download afterward", async () => {
    const applySpy = vi.spyOn(backend, "applyAutotune");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    const call = applySpy.mock.calls[0][0];
    expect(call.path).toBe(instruments[0].path);
    expect(call.edits.notes.length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByRole("button", { name: /^save as sample$/i })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /^download$/i })).not.toBeDisabled();
  });

  it("Tune to scale is disabled while Chromatic is selected, and Key/Scale are prominent", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    expect(screen.getByRole("combobox", { name: /^scale$/i })).toHaveValue("minor");
    expect(screen.getByRole("combobox", { name: /^key$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tune to scale/i })).not.toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: /^scale$/i }), { target: { value: "chromatic" } });
    expect(screen.getByRole("button", { name: /tune to scale/i })).toBeDisabled();
  });

  it("renders a Play button for the loaded source and plays it via samplePlayer", async () => {
    const playSpy = vi.spyOn(samplePlayer, "playPath");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    const playButton = screen.getByRole("button", { name: /play source/i });
    expect(playButton).not.toBeDisabled();

    fireEvent.click(playButton);

    expect(playSpy).toHaveBeenCalledWith(
      "autotune-source",
      expect.any(String),
      expect.objectContaining({ kind: "sample", label: "Autotune source" })
    );
  });

  it("changing Retune Speed updates the edits sent to backend.applyAutotune", async () => {
    const applySpy = vi.spyOn(backend, "applyAutotune");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    fireEvent.keyDown(screen.getByRole("slider", { name: /retune speed/i }), { key: "Home" });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    const call = applySpy.mock.calls[0][0];
    expect(call.edits.snapStrength).toBeCloseTo(0.3, 2);
    expect(call.edits.transitionMs).toBe(150);
  });
});
