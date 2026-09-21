import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJobs } from "./useJobs";
import { emitMockProgress } from "@/lib/events";

describe("useJobs timer math", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks elapsedSec from the real startedAt every 250ms", async () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { result } = renderHook(() => useJobs());

    await act(async () => {
      emitMockProgress({ stage: "separate", percent: 10, message: "Splitting drum kit...", trackId: "t1", startedAt, elapsedSec: 0 });
      await Promise.resolve();
    });

    expect(result.current.jobs.t1).toBeTruthy();
    expect(result.current.jobs.t1.elapsedSec).toBeCloseTo(0, 1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.jobs.t1.elapsedSec).toBeCloseTo(5, 1);
  });

  it("clears the job on completion (percent 100)", async () => {
    const startedAt = new Date().toISOString();
    const { result } = renderHook(() => useJobs());

    await act(async () => {
      emitMockProgress({ stage: "separate", percent: 50, message: "Working...", trackId: "t2", startedAt });
      await Promise.resolve();
    });
    expect(result.current.jobs.t2).toBeTruthy();

    await act(async () => {
      emitMockProgress({ stage: "separate", percent: 100, message: "Done", trackId: "t2", startedAt });
      await Promise.resolve();
    });
    expect(result.current.jobs.t2).toBeUndefined();
  });

  it("clears the job on a failure", async () => {
    const startedAt = new Date().toISOString();
    const { result } = renderHook(() => useJobs());

    await act(async () => {
      emitMockProgress({ stage: "separate", percent: 40, message: "Working...", trackId: "t3", startedAt });
      await Promise.resolve();
    });
    expect(result.current.jobs.t3).toBeTruthy();

    await act(async () => {
      emitMockProgress({ stage: "separate", percent: 40, message: "GPU out of memory", trackId: "t3", startedAt, failed: true });
      await Promise.resolve();
    });
    expect(result.current.jobs.t3).toBeUndefined();
  });
});
