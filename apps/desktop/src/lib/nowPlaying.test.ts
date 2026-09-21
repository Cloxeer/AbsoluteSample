import { beforeEach, describe, expect, it, vi } from "vitest";
import { nowPlaying } from "./nowPlaying";

function makeController() {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  };
}

describe("nowPlaying", () => {
  beforeEach(() => {
    nowPlaying.stop();
    vi.clearAllMocks();
  });

  it("stops the previous controller when a different source starts", () => {
    const mixController = makeController();
    nowPlaying.start("mix", "Mix", 120, mixController);
    expect(nowPlaying.getState()).toMatchObject({ kind: "mix", label: "Mix", isPlaying: true });

    const sampleController = makeController();
    nowPlaying.start("sample", "Kick", 1, sampleController);

    expect(mixController.stop).toHaveBeenCalledTimes(1);
    expect(sampleController.stop).not.toHaveBeenCalled();
    expect(nowPlaying.getState()).toMatchObject({ kind: "sample", label: "Kick", isPlaying: true, time: 0 });
  });

  it("does not stop the controller when the same controller restarts", () => {
    const controller = makeController();
    nowPlaying.start("loop", "Loop", 4, controller);
    nowPlaying.start("loop", "Loop", 4, controller);
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it("dispatches pause/resume to the active controller", () => {
    const controller = makeController();
    nowPlaying.start("mix", "Mix", 120, controller);

    nowPlaying.pause();
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(nowPlaying.getState().isPlaying).toBe(false);

    nowPlaying.resume();
    expect(controller.resume).toHaveBeenCalledTimes(1);
    expect(nowPlaying.getState().isPlaying).toBe(true);
  });

  it("stop() dispatches to the controller and resets time/kind", () => {
    const controller = makeController();
    nowPlaying.start("mix", "Mix", 120, controller);
    nowPlaying.tick(42);
    expect(nowPlaying.getState().time).toBe(42);

    nowPlaying.stop();
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(nowPlaying.getState()).toMatchObject({ kind: null, label: "", time: 0, isPlaying: false });
  });

  it("notifies subscribers on state changes", () => {
    const cb = vi.fn();
    const unsubscribe = nowPlaying.subscribe(cb);
    const controller = makeController();
    nowPlaying.start("mix", "Mix", 120, controller);
    expect(cb).toHaveBeenCalled();
    unsubscribe();
  });
});
