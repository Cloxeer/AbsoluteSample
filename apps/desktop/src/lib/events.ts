import { isTauri } from "./mediaUrl";
import type { EngineProgressPayload, ModelsChangedPayload, ProgressPayload, StemReadyPayload } from "./types";

export const PROGRESS_EVENT = "pipeline://progress";
export const ENGINE_PROGRESS_EVENT = "engine://progress";
export const STEM_READY_EVENT = "pipeline://stem";
export const MODELS_EVENT = "engine://models";

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

/** Subscribes to a Tauri event on desktop, or to the in-memory mock bus on web/tests. */
async function listenAny<T>(name: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(name, (event) => handler(event.payload));
  }
  const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
  mockBus.addEventListener(name, listener);
  return () => mockBus.removeEventListener(name, listener);
}

export function emitMockStemReady(payload: StemReadyPayload): void {
  mockBus.dispatchEvent(new CustomEvent<StemReadyPayload>(STEM_READY_EVENT, { detail: payload }));
}

export function emitMockModelsChanged(payload: ModelsChangedPayload): void {
  mockBus.dispatchEvent(new CustomEvent<ModelsChangedPayload>(MODELS_EVENT, { detail: payload }));
}

/** v11: a stem is ready early while a split is still running (vocals first). */
export function onStemReady(handler: (payload: StemReadyPayload) => void): Promise<Unlisten> {
  return listenAny<StemReadyPayload>(STEM_READY_EVENT, handler);
}

/** v11: the resident-models status changed (load/offload, or an auto-offload with a reason). */
export function onModelsChanged(handler: (payload: ModelsChangedPayload) => void): Promise<Unlisten> {
  return listenAny<ModelsChangedPayload>(MODELS_EVENT, handler);
}
