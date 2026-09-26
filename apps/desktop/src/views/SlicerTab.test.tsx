import { describe, expect, it, vi } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import { SlicerTab } from "./SlicerTab";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";

vi.mock("wavesurfer.js", () => {
  return {
    default: {
      create: vi.fn(() => ({
        on: vi.fn(),
        destroy: vi.fn(),
        play: vi.fn(),
        pause: vi.fn(),
        setTime: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 15),
        setVolume: vi.fn(),
        isPlaying: vi.fn(() => false),
      })),
    },
  };
});

vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => {
  return {
    default: {
      create: vi.fn(() => ({
        on: vi.fn(),
        addRegion: vi.fn(() => ({ setOptions: vi.fn(), start: 0, end: 15 })),
      })),
    },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

describe("SlicerTab", () => {
  it("renders with the seeded YouTube URL in the input", () => {
    render(<SlicerTab />);
    const input = screen.getByLabelText("or paste a YouTube link") as HTMLInputElement;
    expect(input.value).toBe("https://youtu.be/nRKgT3d6xoE");
  });

  it("renders a Fetch button", () => {
    render(<SlicerTab />);
    expect(screen.getByText("Fetch")).toBeInTheDocument();
  });

  it("renders a Split button (not the old 'Split into 4 stems' label) once a loop exists", async () => {
    const { result: engineResult } = renderHook(() => useAudioEngine());
    const { result: syncResult } = renderHook(() => useSyncPlayback());

    // Drive the engine straight to the post-cut state the Split button appears in.
    await act(async () => {
      await engineResult.current.fetchAudio("https://youtu.be/nRKgT3d6xoE");
    });
    await act(async () => {
      await engineResult.current.trimLoop(engineResult.current.engine.track!.id, 0, 15);
    });

    render(<SlicerTab engineApi={engineResult.current} syncApi={syncResult.current} />);
    expect(await screen.findByText("Split")).toBeInTheDocument();
    expect(screen.queryByText("Split into 4 stems")).not.toBeInTheDocument();
  });

  it("shows the hero drop zone (primary) and YouTube row (secondary) when no track is loaded", () => {
    render(<SlicerTab />);
    expect(screen.getByText("Drop a WAV, FLAC or MP3 here")).toBeInTheDocument();
    expect(screen.getByText("Choose file")).toBeInTheDocument();
    expect(screen.getByText("or paste a YouTube link")).toBeInTheDocument();
  });

  it("calls importLocal when a file is chosen via the browser file input", async () => {
    const { result: engineResult } = renderHook(() => useAudioEngine());
    const importLocalSpy = vi.spyOn(engineResult.current, "importLocal");

    render(<SlicerTab engineApi={engineResult.current} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["dummy"], "my-song.wav", { type: "audio/wav" });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(importLocalSpy).toHaveBeenCalledWith("my-song.wav");
  });

  it("renders a Karaoke button beside Split, and calls separateKaraoke when clicked", async () => {
    const { result: engineResult } = renderHook(() => useAudioEngine());
    const { result: syncResult } = renderHook(() => useSyncPlayback());

    await act(async () => {
      await engineResult.current.fetchAudio("https://youtu.be/nRKgT3d6xoE");
    });
    await act(async () => {
      await engineResult.current.trimLoop(engineResult.current.engine.track!.id, 0, 15);
    });

    const trackId = engineResult.current.engine.track!.id;
    const separateKaraokeSpy = vi.spyOn(engineResult.current, "separateKaraoke").mockResolvedValue([]);

    render(<SlicerTab engineApi={engineResult.current} syncApi={syncResult.current} />);
    // Wait for the mock engineStatus() fetch (which the Karaoke/Split buttons are gated on) to resolve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const karaokeButton = await screen.findByText("Karaoke");
    expect(karaokeButton).toBeInTheDocument();
    expect(karaokeButton.closest("button")).not.toBeDisabled();

    await act(async () => {
      karaokeButton.click();
    });

    expect(separateKaraokeSpy).toHaveBeenCalledWith(trackId, false);
  });

  it("renders karaoke results (Instrumental and Vocals) once karaoke stems exist", async () => {
    const { result: engineResult } = renderHook(() => useAudioEngine());

    await act(async () => {
      await engineResult.current.fetchAudio("https://youtu.be/nRKgT3d6xoE");
    });
    await act(async () => {
      await engineResult.current.trimLoop(engineResult.current.engine.track!.id, 0, 15);
    });
    await act(async () => {
      await engineResult.current.separateKaraoke(engineResult.current.engine.track!.id, false);
    });

    // Use a stub sync API instead of the real useSyncPlayback hook: mixEngine needs a real
    // AudioContext (unavailable in jsdom), which only gets touched once tracks are registered.
    const stubSync = {
      tracks: [],
      currentTime: 0,
      mode: "mix" as const,
      auditionId: null,
      upsertTrack: () => {},
      registerInstance: () => {},
      unregisterInstance: () => {},
      handleTimeUpdate: () => {},
      handleFinish: () => {},
      auditionTrack: () => {},
      seek: () => {},
      stopAll: () => {},
    };

    render(<SlicerTab engineApi={engineResult.current} syncApi={stubSync as unknown as ReturnType<typeof useSyncPlayback>} />);
    expect(await screen.findByText("Karaoke")).toBeInTheDocument();
    expect(await screen.findByText(/Instrumental/i)).toBeInTheDocument();
    expect(await screen.findByText(/Vocals/i)).toBeInTheDocument();
  });

  it("shows the New link bar (not the hero) once a track is loaded", async () => {
    const { result: engineResult } = renderHook(() => useAudioEngine());
    const { result: syncResult } = renderHook(() => useSyncPlayback());

    await act(async () => {
      await engineResult.current.fetchAudio("https://youtu.be/nRKgT3d6xoE");
    });

    render(<SlicerTab engineApi={engineResult.current} syncApi={syncResult.current} />);
    expect(screen.queryByText("Paste a YouTube link")).not.toBeInTheDocument();
    expect(await screen.findByText(/This song is a scan/)).toBeInTheDocument();
  });
});
