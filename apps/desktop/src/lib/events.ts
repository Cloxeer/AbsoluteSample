import { isTauri } from "./mediaUrl";
import type { ProgressPayload } from "./types";

export const PROGRESS_EVENT = "pipeline://progress";

const mockBus = new EventTarget();

export function emitMockProgress(payload: ProgressPayload): void {
  mockBus.dispatchEvent(new CustomEvent<ProgressPayload>(PROGRESS_EVENT, { detail: payload }));
}

export type Unlisten = () => void;

export async function onProgress(handler: (payload: ProgressPayload) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<ProgressPayload>(PROGRESS_EVENT, (event) => {
      handler(event.payload);
    });
    return unlisten;
  }
  const listener = (event: Event) => {
    handler((event as CustomEvent<ProgressPayload>).detail);
  };
  mockBus.addEventListener(PROGRESS_EVENT, listener);
  return () => mockBus.removeEventListener(PROGRESS_EVENT, listener);
}
