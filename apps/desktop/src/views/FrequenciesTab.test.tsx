import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FrequenciesTab } from "./FrequenciesTab";
import { backend } from "@/lib/backend";
import type { InstrumentStem, Sample, TrackInfo } from "@/lib/types";

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

describe("FrequenciesTab", () => {
  it("shows the empty state when there are no sources", () => {
    render(<FrequenciesTab track={track} instruments={[]} analysis={null} samples={[]} />);
    expect(screen.getByText(/split a song or save a sample/i)).toBeInTheDocument();
  });

  it("shows the analyze-prompt empty state when sources exist but nothing has been analyzed", () => {
    render(<FrequenciesTab track={track} instruments={instruments} analysis={null} samples={samples} />);
    expect(screen.getByText(/pick a stem or sample, then analyze/i)).toBeInTheDocument();
  });

  it("calls backend.analyzeFrequencies for the selected source and renders the result", async () => {
    const spy = vi.spyOn(backend, "analyzeFrequencies");
    render(<FrequenciesTab track={track} instruments={instruments} analysis={null} samples={samples} />);

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ path: instruments[0].path })));
    await waitFor(() => expect(screen.getByTestId("spectrum-chart")).toBeInTheDocument());
    expect(screen.getByText("Sub")).toBeInTheDocument();
    expect(screen.getByText("Air")).toBeInTheDocument();
    expect(screen.getAllByText(/in tune/i).length).toBeGreaterThan(0);
  });

  it("renders a pre-supplied analysis without needing to click Analyze", () => {
    render(
      <FrequenciesTab
        track={track}
        instruments={instruments}
        analysis={{
          spectrum: [
            { hz: 20, db: -10 },
            { hz: 20000, db: -100 },
          ],
          bands: [{ key: "sub", name: "Sub", lowHz: 20, highHz: 60, db: -18, sharePct: 6 }],
          tuning: { referenceHz: 440, avgCentsOff: 3, inTunePct: 0.9, estimatedRefHz: 440 },
          key: null,
          durationSec: 10,
        }}
        samples={samples}
      />
    );
    expect(screen.getByTestId("spectrum-chart")).toBeInTheDocument();
    expect(screen.getByText("Sub")).toBeInTheDocument();
  });
});
