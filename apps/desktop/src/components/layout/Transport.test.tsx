import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Transport } from "./Transport";
import { backend } from "@/lib/backend";

vi.mock("@/lib/backend", () => ({
  backend: {
    librarySize: vi.fn(),
    engineStatus: vi.fn(),
    clearScans: vi.fn(),
    emptyTrash: vi.fn(),
  },
}));

describe("Transport", () => {
  beforeEach(() => {
    vi.mocked(backend.librarySize).mockResolvedValue({ bytes: 0, tracks: 0, scans: 0, samplesBytes: 0, trashBytes: 0 });
    vi.mocked(backend.engineStatus).mockResolvedValue({
      installed: true,
      pythonFound: true,
      pythonPath: null,
      venvPath: null,
      torchVersion: null,
      cuda: false,
      gpuName: null,
      modelsPresent: [],
      enginePath: "",
      busy: false,
      busyTrackId: null,
    });
    vi.mocked(backend.clearScans).mockResolvedValue(undefined);
    vi.mocked(backend.emptyTrash).mockResolvedValue(undefined);
  });

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

  describe("storage and GPU chips", () => {
    beforeEach(() => {
      vi.mocked(backend.librarySize).mockReset().mockResolvedValue({
        bytes: 1_500_000_000,
        tracks: 1,
        scans: 0,
        samplesBytes: 500_000_000,
        trashBytes: 0,
      });
      vi.mocked(backend.engineStatus).mockReset().mockResolvedValue({
        installed: true,
        pythonFound: true,
        pythonPath: null,
        venvPath: null,
        torchVersion: null,
        cuda: false,
        gpuName: null,
        modelsPresent: [],
        enginePath: "",
        busy: false,
        busyTrackId: null,
      });
      vi.mocked(backend.clearScans).mockReset().mockResolvedValue(undefined);
      vi.mocked(backend.emptyTrash).mockReset().mockResolvedValue(undefined);
    });

    it("formats the storage chip from librarySize's bytes + samplesBytes + trashBytes", async () => {
      render(<Transport {...baseProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("storage-chip")).toHaveTextContent("1.9 GB");
      });
    });

    it("does not show the GPU chip when engineStatus.busy is false", async () => {
      render(<Transport {...baseProps} />);
      await waitFor(() => expect(backend.engineStatus).toHaveBeenCalled());
      expect(screen.queryByTestId("gpu-busy-chip")).not.toBeInTheDocument();
    });

    it("shows 'GPU busy: <title>' when engineStatus.busy is true", async () => {
      vi.mocked(backend.engineStatus).mockResolvedValue({
        installed: true,
        pythonFound: true,
        pythonPath: null,
        venvPath: null,
        torchVersion: null,
        cuda: false,
        gpuName: null,
        modelsPresent: [],
        enginePath: "",
        busy: true,
        busyTrackId: "track-42",
      });
      render(<Transport {...baseProps} />);
      await waitFor(() => {
        expect(screen.getByTestId("gpu-busy-chip")).toHaveTextContent("GPU busy: track-42");
      });
    });
  });
});
