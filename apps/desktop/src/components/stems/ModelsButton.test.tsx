import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelsButton, MODELS_TOOLTIP } from "./ModelsButton";
import { backend } from "@/lib/backend";
import { emitMockModelsChanged } from "@/lib/events";
import { toastStore } from "@/lib/toast";
import type { ModelsStatus } from "@/lib/types";

const IDLE: ModelsStatus = { loaded: false, loading: false, kept: false, models: [], vramMb: null };
const LOADED: ModelsStatus = { loaded: true, loading: false, kept: true, models: ["vocals", "instruments"], vramMb: 2900 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ModelsButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("goes Keep -> Loading -> Offload -> Offloading -> Keep", async () => {
    vi.spyOn(backend, "modelsStatus").mockResolvedValue(IDLE);
    const keep = deferred<ModelsStatus>();
    const off = deferred<ModelsStatus>();
    const keepSpy = vi.spyOn(backend, "keepModelsLoaded").mockReturnValue(keep.promise);
    const offSpy = vi.spyOn(backend, "offloadModels").mockReturnValue(off.promise);

    render(<ModelsButton />);
    const button = await screen.findByRole("button", { name: "Keep models loaded" });
    expect(button).toHaveAttribute("title", MODELS_TOOLTIP);

    fireEvent.click(button);
    const loading = await screen.findByRole("button", { name: "Loading models…" });
    expect(loading).toBeDisabled();
    expect(keepSpy).toHaveBeenCalledTimes(1);

    await act(async () => keep.resolve(LOADED));
    const offload = await screen.findByRole("button", { name: "Offload models" });
    expect(offload).not.toBeDisabled();

    fireEvent.click(offload);
    expect(await screen.findByRole("button", { name: "Offloading…" })).toBeDisabled();
    expect(offSpy).toHaveBeenCalledTimes(1);

    await act(async () => off.resolve(IDLE));
    expect(await screen.findByRole("button", { name: "Keep models loaded" })).not.toBeDisabled();
  });

  it("starts from the current status and shows a notice with the reason on auto-offload", async () => {
    vi.spyOn(backend, "modelsStatus").mockResolvedValue(LOADED);
    const publish = vi.spyOn(toastStore, "publish");
    render(<ModelsButton />);
    await screen.findByRole("button", { name: "Offload models" });

    await act(async () => {
      emitMockModelsChanged({ ...IDLE, reason: "A game needs the graphics card" });
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Keep models loaded" })).toBeInTheDocument();
    expect(publish).toHaveBeenCalledWith("A game needs the graphics card");
  });

  it("runs the PC busy check before loading", async () => {
    vi.spyOn(backend, "modelsStatus").mockResolvedValue(IDLE);
    const keepSpy = vi.spyOn(backend, "keepModelsLoaded").mockResolvedValue(LOADED);
    const gate = vi.fn(async (_label: string, run: (o: { lowPriority?: boolean }) => Promise<unknown>) => {
      await run({});
    });
    render(<ModelsButton gate={gate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep models loaded" }));
    await waitFor(() => expect(keepSpy).toHaveBeenCalled());
    expect(gate).toHaveBeenCalledWith("Loading the models", expect.any(Function));
  });
});
