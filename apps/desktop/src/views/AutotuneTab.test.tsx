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
    // No note was tuned, so untouched notes stay natural and none are sent.
    expect(call.edits.notes).toEqual([]);

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

  it("renders a single unified playhead element shared by the waveform lane and the pitch grid", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    // Exactly one playhead bar exists, and it sits in the shared container that wraps both the
    // waveform (autotune-waveform) and the pitch grid (autotune-editor), so a single left offset
    // (via the shared xForSec/KEYBOARD_WIDTH mapping) positions it across both lanes at once.
    const playheads = screen.getAllByTestId("autotune-playhead");
    expect(playheads).toHaveLength(1);
    const container = playheads[0].parentElement as HTMLElement;
    expect(container.querySelector('[data-testid="autotune-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="autotune-editor"]')).toBeTruthy();
  });

  it("Tune to scale snaps every note's target to the selected scale and triggers a live preview render", async () => {
    const applySpy = vi.spyOn(backend, "applyAutotune");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    applySpy.mockClear();
    fireEvent.change(screen.getByRole("combobox", { name: /^scale$/i }), { target: { value: "major" } });
    fireEvent.click(screen.getByRole("button", { name: /tune to scale/i }));

    // The live preview loop (debounced applyAutotune) picks up the new targets automatically.
    await waitFor(() => expect(applySpy).toHaveBeenCalled(), { timeout: 2000 });
    const call = applySpy.mock.calls[applySpy.mock.calls.length - 1][0];
    const majorPcs = [0, 2, 4, 5, 7, 9, 11].map((s) => (s + (["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"].indexOf("C"))) % 12);
    for (const n of call.edits.notes) {
      expect(majorPcs).toContain(((n.targetMidi % 12) + 12) % 12);
    }

    // And the Tuned compare option becomes playable once the preview lands.
    await waitFor(() => expect(screen.getByRole("button", { name: /pause tuned|play tuned/i })).not.toBeDisabled(), {
      timeout: 2000,
    });
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

  it("debounces the live preview: an edit schedules applyAutotune ~350ms later, not immediately", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const applySpy = vi.spyOn(backend, "applyAutotune");
      render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
      pickSongSource("Vocals");
      fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
      await vi.waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

      applySpy.mockClear();
      // An edit: bump Retune Speed, which changes the edits payload the preview effect watches.
      fireEvent.keyDown(screen.getByRole("slider", { name: /retune speed/i }), { key: "End" });

      // Not yet: the debounce hasn't elapsed.
      await vi.advanceTimersByTimeAsync(100);
      expect(applySpy).not.toHaveBeenCalled();

      // Past the ~350ms debounce window, the background render fires exactly once for this edit.
      await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a Performance readout from the analyze/apply results' seconds and peakRssMb", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    await waitFor(() => expect(screen.getByText(/^Performance:/i)).toBeInTheDocument());
    expect(screen.getByText(/analyzed in 12\.4 s/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(screen.getByText(/apply 40\.3 s, 1000 mb/i)).toBeInTheDocument());
  });

  it("drags a single note and renders only the region around it, using the cached pitch", async () => {
    const applySpy = vi.spyOn(backend, "applyAutotune");
    const { container } = render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    applySpy.mockClear();
    const editor = screen.getByTestId("autotune-editor");
    const noteRect = container.querySelector('rect.cursor-grab') as SVGRectElement;
    expect(noteRect).toBeTruthy();

    fireEvent.pointerDown(noteRect, { pointerId: 1 });
    fireEvent.pointerMove(editor, { clientY: 10 });
    fireEvent.pointerUp(editor);

    await waitFor(() => expect(applySpy).toHaveBeenCalled(), { timeout: 2000 });
    const call = applySpy.mock.calls[applySpy.mock.calls.length - 1][0];
    expect(call.regionStartSec).toBeDefined();
    expect(call.regionEndSec).toBeDefined();
    expect(call.regionEndSec! - call.regionStartSec!).toBeLessThan(2);
    expect(call.pitchCachePath).toMatch(/\.pitch\.json$/);
  });

  it("colors untouched notes by detected cents and dragged/tuned notes green, with a legend", async () => {
    const realAnalyze = backend.analyzePitch.bind(backend);
    vi.spyOn(backend, "analyzePitch").mockImplementationOnce(async (req) => {
      const r = await realAnalyze(req);
      return { ...r, notes: r.notes.map((n, i) => (i === 0 ? { ...n, cents: 40 } : i === 1 ? { ...n, cents: 18 } : n)) };
    });
    const applySpy = vi.spyOn(backend, "applyAutotune");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    pickSongSource("Vocals");
    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    expect(screen.getByText("In tune (0-10 cents)")).toBeInTheDocument();
    expect(screen.getByText("Slightly off (10-25)")).toBeInTheDocument();
    expect(screen.getByText("Off pitch (25+)")).toBeInTheDocument();
    expect(screen.getByText(/tuned notes turn green/i)).toBeInTheDocument();

    const note0 = screen.getByTestId("autotune-note-0");
    expect(note0.getAttribute("fill")).toBe("#E85D5D");
    expect(screen.getByTestId("autotune-note-1").getAttribute("fill")).toBe("#F2B33D");

    applySpy.mockClear();
    const editor = screen.getByTestId("autotune-editor");
    fireEvent.pointerDown(note0, { pointerId: 1 });
    expect(screen.getByTestId("autotune-note-0").getAttribute("fill")).toBe("#3DDC97");
    fireEvent.pointerMove(editor, { clientY: 10 });
    fireEvent.pointerUp(editor);
    expect(screen.getByTestId("autotune-note-0").getAttribute("fill")).toBe("#3DDC97");
    expect(screen.getByTestId("autotune-note-0").textContent).toMatch(/tuned to 0 cents/);
    expect(screen.getByTestId("autotune-note-1").getAttribute("fill")).toBe("#F2B33D");

    await waitFor(() => expect(applySpy).toHaveBeenCalled(), { timeout: 2000 });
    const call = applySpy.mock.calls[applySpy.mock.calls.length - 1][0];
    expect(call.edits.notes).toHaveLength(1);
    expect(typeof call.edits.notes[0].sourceMidi).toBe("number");

    fireEvent.change(screen.getByRole("combobox", { name: /^scale$/i }), { target: { value: "major" } });
    fireEvent.click(screen.getByRole("button", { name: /tune to scale/i }));
    expect(screen.getByTestId("autotune-note-1").getAttribute("fill")).toBe("#3DDC97");
  });

  it("cancels a stale in-flight preview render when a newer edit supersedes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const applySpy = vi.spyOn(backend, "applyAutotune");
      render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
      pickSongSource("Vocals");
      fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
      await vi.waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

      applySpy.mockClear();
      fireEvent.keyDown(screen.getByRole("slider", { name: /retune speed/i }), { key: "End" });
      await vi.advanceTimersByTimeAsync(200); // mid-debounce
      fireEvent.keyDown(screen.getByRole("slider", { name: /humanize/i }), { key: "End" }); // supersedes it

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
      // The one call that did land reflects the latest edit (humanize maxed out => longer transition).
      const call = applySpy.mock.calls[0][0];
      expect(call.edits.transitionMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
