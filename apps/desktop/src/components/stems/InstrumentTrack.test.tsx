import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  soundsLike: "Strings",
  tags: [
    { label: "Violin, fiddle", score: 0.62 },
    { label: "Bowed string instrument", score: 0.55 },
    { label: "Guitar", score: 0.21 },
  ],
};

const baseProps = {
  wavUrl: null,
  solo: false,
  mute: false,
  volume: 1,
  isPlaying: false,
  onTogglePlay: vi.fn(),
  onToggleSolo: vi.fn(),
  onToggleMute: vi.fn(),
  onVolumeChange: vi.fn(),
  onDownload: vi.fn(),
};

describe("InstrumentTrack soundsLike caption", () => {
  it("renders the caption with the top tag label and score when soundsLike is set", () => {
    render(<InstrumentTrack {...baseProps} stem={baseStem} />);
    expect(screen.getByText("sounds like Strings (violin, fiddle 0.62)")).toBeInTheDocument();
  });

  it("does not render a caption when soundsLike is not set", () => {
    const stem: InstrumentStem = { ...baseStem, soundsLike: null, tags: undefined };
    render(<InstrumentTrack {...baseProps} stem={stem} />);
    expect(screen.queryByText(/sounds like/)).not.toBeInTheDocument();
  });
});
