import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutotuneTab } from "./AutotuneTab";
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

describe("AutotuneTab", () => {
  it("shows the empty state when there are no sources", () => {
    render(<AutotuneTab track={track} instruments={[]} samples={[]} />);
    expect(screen.getByText(/pick a vocal stem or sample, then analyze/i)).toBeInTheDocument();
  });

  it("shows the empty state before analyzing even when sources exist", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    expect(screen.getAllByText(/pick a vocal stem or sample, then analyze/i).length).toBeGreaterThan(0);
  });

  it("lists vocal stems and any other stem in the source picker", () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    const select = screen.getByRole("combobox", { name: /source/i });
    expect(select).toHaveTextContent("Vocals");
    expect(select).toHaveTextContent("Drums");
  });

  it("calls backend.analyzePitch for the selected source and renders the editor", async () => {
    const spy = vi.spyOn(backend, "analyzePitch");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ path: instruments[0].path }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());
    expect(screen.getByText(/in plain words/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
  });

  it("disables Apply-derived actions (compare tuned, save, download) until Apply runs", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /pause tuned|play tuned/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^save as sample$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^download$/i })).toBeDisabled();
  });

  it("applies edits and enables compare/save/download afterward", async () => {
    const applySpy = vi.spyOn(backend, "applyAutotune");
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    const call = applySpy.mock.calls[0][0];
    expect(call.path).toBe(instruments[0].path);
    expect(call.edits.notes.length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByRole("button", { name: /^save as sample$/i })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /^download$/i })).not.toBeDisabled();
  });

  it("Tune to scale is disabled while Chromatic is selected", async () => {
    render(<AutotuneTab track={track} instruments={instruments} samples={samples} />);
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() => expect(screen.getByTestId("autotune-editor")).toBeInTheDocument());

    expect(screen.getByRole("combobox", { name: /^scale$/i })).toHaveValue("minor");
    expect(screen.getByRole("button", { name: /tune to scale/i })).not.toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: /^scale$/i }), { target: { value: "chromatic" } });
    expect(screen.getByRole("button", { name: /tune to scale/i })).toBeDisabled();
  });
});
