import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBusyGate, type GateRunOptions } from "./BusyGate";
import { backend } from "@/lib/backend";
import type { SystemLoad } from "@/lib/types";

const OK: SystemLoad = { ramTotalGb: 32, ramFreeGb: 20, vramTotalGb: 12, vramFreeGb: 10, gpuUtil: 3, verdict: "ok", reasons: [] };
const BUSY: SystemLoad = { ...OK, gpuUtil: 96, verdict: "busy", reasons: ["The graphics card is 96% busy (a game?)"] };
const LOW: SystemLoad = { ...OK, ramFreeGb: 2.1, verdict: "insufficient", reasons: ["Only 2.1 GB of memory free (needs 5 GB)"] };

function Harness({ run, pollMs }: { run: (opts: GateRunOptions) => Promise<unknown>; pollMs?: number }) {
  const { gate, element } = useBusyGate(pollMs);
  return (
    <div>
      <button type="button" onClick={() => void gate("Split", run)}>
        Go
      </button>
      {element}
    </div>
  );
}

describe("useBusyGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs right away when the PC is ok", async () => {
    vi.spyOn(backend, "systemLoad").mockResolvedValue(OK);
    const run = vi.fn(async () => {});
    render(<Harness run={run} />);
    fireEvent.click(screen.getByText("Go"));
    await waitFor(() => expect(run).toHaveBeenCalledWith({}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks first when busy; Run anyway starts it at low priority", async () => {
    vi.spyOn(backend, "systemLoad").mockResolvedValue(BUSY);
    const run = vi.fn(async () => {});
    render(<Harness run={run} />);
    fireEvent.click(screen.getByText("Go"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Your PC is busy")).toBeInTheDocument();
    expect(screen.getByText("The graphics card is 96% busy (a game?)")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Run anyway (low priority)"));
    expect(run).toHaveBeenCalledWith({ lowPriority: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Wait and start automatically polls until the PC is free, then starts (and can be cancelled)", async () => {
    const load = vi.spyOn(backend, "systemLoad");
    load.mockResolvedValueOnce(BUSY).mockResolvedValueOnce(BUSY).mockResolvedValue(OK);
    const run = vi.fn(async () => {});
    render(<Harness run={run} pollMs={15} />);
    fireEvent.click(screen.getByText("Go"));
    fireEvent.click(await screen.findByText("Wait and start automatically"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for your PC to free up/)).toBeInTheDocument();
    await waitFor(() => expect(run).toHaveBeenCalledWith({}));
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/Waiting for your PC to free up/)).not.toBeInTheDocument();
  });

  it("stops waiting on Cancel without running", async () => {
    vi.spyOn(backend, "systemLoad").mockResolvedValue(BUSY);
    const run = vi.fn(async () => {});
    render(<Harness run={run} pollMs={15} />);
    fireEvent.click(screen.getByText("Go"));
    fireEvent.click(await screen.findByText("Wait and start automatically"));
    fireEvent.click(screen.getByText("Cancel"));
    await new Promise((r) => setTimeout(r, 60));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByText(/Waiting for your PC to free up/)).not.toBeInTheDocument();
  });

  it("offers no Run anyway when memory is insufficient; Cancel does nothing", async () => {
    vi.spyOn(backend, "systemLoad").mockResolvedValue(LOW);
    const run = vi.fn(async () => {});
    render(<Harness run={run} />);
    fireEvent.click(screen.getByText("Go"));
    expect(await screen.findByText("Not enough free memory")).toBeInTheDocument();
    expect(screen.getByText("Only 2.1 GB of memory free (needs 5 GB)")).toBeInTheDocument();
    expect(screen.queryByText("Run anyway (low priority)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});
