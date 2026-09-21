import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Transport } from "./Transport";

describe("Transport", () => {
  const baseProps = {
    deps: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", ytdlp: "yt-dlp", ok: true },
    isPlaying: false,
    currentTime: 0,
    mode: "mix" as const,
    auditionLabel: null,
    loopEnabled: false,
    bpm: null,
    masterVolume: 1,
    onPlayPause: vi.fn(),
    onStop: vi.fn(),
    onToggleLoop: vi.fn(),
    onMasterVolumeChange: vi.fn(),
  };

  it("renders the mm:ss.mmm time readout and Mix mode chip", () => {
    render(<Transport {...baseProps} currentTime={65.5} />);
    expect(screen.getByText("01:05.500")).toBeInTheDocument();
    expect(screen.getByText("Mix")).toBeInTheDocument();
  });

  it("calls onPlayPause when the play button is clicked", () => {
    const onPlayPause = vi.fn();
    render(<Transport {...baseProps} onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByLabelText("Play mix"));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("shows the audition caption and chip while in audition mode", () => {
    render(<Transport {...baseProps} mode="audition" auditionLabel="Solo: Drums / Sub" />);
    expect(screen.getAllByText("Solo: Drums / Sub").length).toBeGreaterThan(0);
    expect(screen.getByText(/Auditioning/)).toBeInTheDocument();
  });

  it("shows the nowPlaying label (e.g. a sample or loop name) as the chip", () => {
    render(<Transport {...baseProps} mode="audition" auditionLabel="Selection" />);
    expect(screen.getAllByText("Selection").length).toBeGreaterThan(0);
  });

  it("reflects nowPlaying.isPlaying directly, independent of mode", () => {
    render(<Transport {...baseProps} isPlaying mode="audition" auditionLabel="Kick" />);
    expect(screen.getByLabelText("Pause mix")).toBeInTheDocument();
  });

  it("toggles loop with an obvious pressed state", () => {
    const onToggleLoop = vi.fn();
    render(<Transport {...baseProps} onToggleLoop={onToggleLoop} loopEnabled />);
    const loopBtn = screen.getByLabelText("Toggle loop");
    expect(loopBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(loopBtn);
    expect(onToggleLoop).toHaveBeenCalledTimes(1);
  });

  it("opens the shortcuts popover", () => {
    render(<Transport {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Keyboard shortcuts"));
    expect(screen.getByText("Play / pause mix")).toBeInTheDocument();
  });
});
