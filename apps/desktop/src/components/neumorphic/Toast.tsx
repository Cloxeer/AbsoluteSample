import { useSyncExternalStore } from "react";
import { Surface } from "./Surface";
import { toastStore } from "@/lib/toast";

/** Global toast stack, rendered bottom-center. Each toast shows a message and one optional action button. */
export function Toast() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
      {toasts.map((toast) => (
        <Surface
          key={toast.id}
          variant="raised"
          className="flex items-center gap-3 px-4 py-2 text-xs text-text"
          role="status"
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="text-accent font-medium underline shrink-0"
              onClick={() => {
                toast.action?.onAction();
                toastStore.dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </Surface>
      ))}
    </div>
  );
}
