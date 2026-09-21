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
});
