import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Toast } from "./Toast";
import { toastStore } from "@/lib/toast";
import { backend } from "@/lib/backend";

vi.mock("@/lib/backend", () => ({
  backend: {
    restoreTrash: vi.fn(),
  },
}));

describe("Toast", () => {
  afterEach(() => {
    // Drain any toasts left over between tests.
    for (const t of toastStore.getSnapshot()) toastStore.dismiss(t.id);
    vi.mocked(backend.restoreTrash).mockReset();
  });

  it("renders a published toast and calls the action's onAction, which calls backend.restoreTrash with the id", () => {
    render(<Toast />);

    act(() => {
      toastStore.publish("Deleted Kick Sample. Undo", {
        label: "Undo",
        onAction: () => backend.restoreTrash({ id: "sample-1" }),
      });
    });

    expect(screen.getByText("Deleted Kick Sample. Undo")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Undo"));

    expect(backend.restoreTrash).toHaveBeenCalledWith({ id: "sample-1" });
  });

  it("dismisses the toast after the action is invoked", () => {
    render(<Toast />);
    act(() => {
      toastStore.publish("Deleted thing. Undo", {
        label: "Undo",
        onAction: () => backend.restoreTrash({ id: "x" }),
      });
    });
    fireEvent.click(screen.getByText("Undo"));
    expect(screen.queryByText("Deleted thing. Undo")).not.toBeInTheDocument();
  });
});
