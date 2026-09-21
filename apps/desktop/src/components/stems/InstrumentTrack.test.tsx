import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InstrumentTrack } from "./InstrumentTrack";
import type { InstrumentStem } from "@/lib/types";

const baseStem: InstrumentStem = {
  key: "guitar",
  label: "Guitar",
  group: "guitar",
  parent: null,
  path: "mock/track/instruments/guitar.wav",
  bytes: 100,
  peakDb: -2,
  rmsDb: -15,
  model: "htdemucs_6s",
  order: 3,
  displayLabel: "Cello",
  detections: [
    { label: "Cello", score: 0.22 },
    { label: "Violin", score: 0.15 },
    { label: "Bowed string", score: 0.11 },
    { label: "Guitar", score: 0.08 },
  ],
  confidence: { score: 0.64, reasons: ["Consistent pitch tracking", "Low spectral overlap"] },
};

const baseProps = {
  wavUrl: null,
  volume: 1,
  isPlaying: false,
  onTogglePlay: vi.fn(),
  onVolumeChange: vi.fn(),
  onDownload: vi.fn(),
};

describe("InstrumentTrack", () => {
  it("renders displayLabel in place of label when present", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    expect(screen.getByText("Cello")).toBeInTheDocument();
    expect(screen.queryByText("Guitar")).not.toBeInTheDocument();
  });

  it("falls back to label when displayLabel is absent", () => {
    const stem: InstrumentStem = { ...baseStem, displayLabel: undefined };
    render(<InstrumentTrack {...baseProps} stem={stem} />);
    expect(screen.getByText("Guitar")).toBeInTheDocument();
  });

  it("renders the top-3 detections line with scores to 2 decimals", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    expect(screen.getByText("Cello 0.22, Violin 0.15, Bowed string 0.11")).toBeInTheDocument();
  });

  it("expands to 5 detections when the +N toggle is clicked", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    const toggle = screen.getByLabelText("Show more detections");
    expect(toggle).toHaveTextContent("+1");
    fireEvent.click(toggle);
    expect(screen.getByText("Cello 0.22, Violin 0.15, Bowed string 0.11, Guitar 0.08")).toBeInTheDocument();
  });

  it("renders a confidence readout with a coloured dot", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    expect(screen.getByText("Confidence 0.64")).toBeInTheDocument();
  });

  it("has no Solo or Mute buttons", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    expect(screen.queryByLabelText(/^Solo/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Mute/)).not.toBeInTheDocument();
  });
});
