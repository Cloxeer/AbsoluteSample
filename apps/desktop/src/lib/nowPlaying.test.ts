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

describe("nowPlaying.toggle (the transport Play button)", () => {
  beforeEach(() => {
    nowPlaying.stop();
    nowPlaying.setTabSource("autotune", null);
  });

  it("starts the tab's own source, then pauses and resumes it", () => {
    const player = makeController();
    const start = vi.fn(() => nowPlaying.start("vocal", "Vocals", 30, player));
    nowPlaying.setTabSource("autotune", { kind: "vocal", label: "Vocals", start });
    const mix = vi.fn();
    nowPlaying.toggle("autotune", mix);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mix).not.toHaveBeenCalled();
    expect(nowPlaying.getState()).toMatchObject({ kind: "vocal", isPlaying: true });
    nowPlaying.toggle("autotune", mix);
    expect(player.pause).toHaveBeenCalledTimes(1);
    nowPlaying.toggle("autotune", mix);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("on the Autotune tab a paused mix does not resume: the vocals start instead", () => {
    const mixCtl = makeController();
    nowPlaying.start("mix", "Mix", 120, mixCtl);
    nowPlaying.pause();
    const start = vi.fn();
    nowPlaying.setTabSource("autotune", { kind: "vocal", label: "Vocals", start });
    nowPlaying.toggle("autotune", vi.fn());
    expect(start).toHaveBeenCalledTimes(1);
    expect(mixCtl.resume).not.toHaveBeenCalled();
  });

  it("on another tab, paused vocals do not resume: the mix plays", () => {
    const vocal = makeController();
    nowPlaying.setTabSource("autotune", { kind: "vocal", label: "Vocals", start: vi.fn() });
    nowPlaying.start("vocal", "Vocals", 30, vocal);
    nowPlaying.pause();
    const mix = vi.fn();
    nowPlaying.toggle("slicer", mix);
    expect(mix).toHaveBeenCalledTimes(1);
    expect(vocal.resume).not.toHaveBeenCalled();
  });

  it("without a tab source it resumes what was paused, else falls back to the mix", () => {
    const mix = vi.fn();
    nowPlaying.toggle("slicer", mix);
    expect(mix).toHaveBeenCalledTimes(1);
    const c = makeController();
    nowPlaying.start("sample", "Kick", 1, c);
    nowPlaying.pause();
    nowPlaying.toggle("slicer", mix);
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(mix).toHaveBeenCalledTimes(1);
  });
});
