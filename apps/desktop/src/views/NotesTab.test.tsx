import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotesTab } from "./NotesTab";
import { backend } from "@/lib/backend";
import type { InstrumentStem, Sample, TrackInfo } from "@/lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
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
];

const samples: Sample[] = [];

const savedSample: Sample = {
  id: "s1",
  name: "Guitar riff",
  path: "/home/user/.absolutesample/samples/s1.wav",
  bytes: 500,
  songId: "t1",
  songTitle: "Test Track",
  stemKey: "guitar",
  stemLabel: "Guitar",
  group: "guitar",
  startSec: 0,
  endSec: 4,
  durationSec: 4,
  bpm: 100,
  createdAt: new Date().toISOString(),
};

const drumStem: InstrumentStem = {
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
};

describe("NotesTab", () => {
  it("shows the empty state when there are no sources", () => {
    render(<NotesTab track={track} loop={null} instruments={[]} analysis={null} samples={[]} />);
    expect(screen.getByText(/split a song or save a sample/i)).toBeInTheDocument();
  });

  it("renders BPM and key placeholders before reading notes", () => {
    render(<NotesTab track={track} loop={null} instruments={instruments} analysis={null} samples={samples} />);
    expect(screen.getByText("BPM")).toBeInTheDocument();
    expect(screen.getByText("Key")).toBeInTheDocument();
  });

  it("calls backend.extractNotes for the selected source and renders the result", async () => {
    const spy = vi.spyOn(backend, "extractNotes");
    render(<NotesTab track={track} loop={null} instruments={instruments} analysis={null} samples={samples} />);

    fireEvent.click(screen.getByRole("button", { name: /read notes/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ path: instruments[0].path })));
    await waitFor(() => expect(screen.getByText("C major")).toBeInTheDocument());
    expect(screen.getByTestId("piano-roll")).toBeInTheDocument();
    expect(screen.getByText(/in plain words/i)).toBeInTheDocument();
  });

  it("disables the play button until a NotesResult exists, then enables it", async () => {
    render(<NotesTab track={track} loop={null} instruments={instruments} analysis={null} samples={samples} />);

    expect(screen.getByRole("button", { name: /play notes/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /read notes/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /play notes/i })).not.toBeDisabled());
  });

  it("calls backend.extractNotes with the sample's real absolute path when a saved sample is chosen", async () => {
    const spy = vi.spyOn(backend, "extractNotes");
    render(<NotesTab track={track} loop={null} instruments={[]} analysis={{ bpm: 128 } as never} samples={[savedSample]} />);

    fireEvent.change(screen.getByLabelText(/source/i), { target: { value: savedSample.path } });
    fireEvent.click(screen.getByRole("button", { name: /read notes/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ path: savedSample.path, bpm: 128 }))
    );
  });

  it("renders the drum step grid, not the piano roll, for a drum stem source", async () => {
    render(<NotesTab track={track} loop={null} instruments={[drumStem]} analysis={null} samples={samples} />);

    fireEvent.change(screen.getByLabelText(/source/i), { target: { value: drumStem.path } });
    fireEvent.click(screen.getByRole("button", { name: /read notes/i }));

    await waitFor(() => expect(screen.getByTestId("drum-step-grid")).toBeInTheDocument());
    expect(screen.queryByTestId("piano-roll")).not.toBeInTheDocument();
    expect(screen.getByText(/each lit block is a hit/i)).toBeInTheDocument();
  });
});
