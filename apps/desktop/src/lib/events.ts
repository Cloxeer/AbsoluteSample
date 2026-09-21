import { isTauri } from "./mediaUrl";
import type { EngineProgressPayload, ProgressPayload } from "./types";

export const PROGRESS_EVENT = "pipeline://progress";
export const ENGINE_PROGRESS_EVENT = "engine://progress";

const mockBus = new EventTarget();

export function emitMockProgress(payload: ProgressPayload): void {
  mockBus.dispatchEvent(new CustomEvent<ProgressPayload>(PROGRESS_EVENT, { detail: payload }));
}

export function emitMockEngineProgress(payload: EngineProgressPayload): void {
  mockBus.dispatchEvent(new CustomEvent<EngineProgressPayload>(ENGINE_PROGRESS_EVENT, { detail: payload }));
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

export async function onEngineProgress(handler: (payload: EngineProgressPayload) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<EngineProgressPayload>(ENGINE_PROGRESS_EVENT, (event) => {
      handler(event.payload);
    });
    return unlisten;
  }
  const listener = (event: Event) => {
    handler((event as CustomEvent<EngineProgressPayload>).detail);
  };
  mockBus.addEventListener(ENGINE_PROGRESS_EVENT, listener);
  return () => mockBus.removeEventListener(ENGINE_PROGRESS_EVENT, listener);
}
