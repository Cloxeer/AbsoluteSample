/**
 * Promise-based client for the pitchcore WebAssembly engine running in ./pitchWorker. The editor only
 * talks to the `PitchEngine` interface, so tests can inject an in-process fake (jsdom has no Worker/wasm).
 */
import {
  matchSnapshot,
  nextStructuralOp,
  type Analysis,
  type AudioPatch,
  type NoteEdit,
  type NoteSnapshot,
} from "./melodyneEditor";

export interface EditResult {
  ok: boolean;
  analysis: Analysis;
  /** Re-rendered spans of output audio (the phrases the edit touched). */
  patches: AudioPatch[];
}

export interface PitchEngine {
  /** Analyses mono samples (seconds of work, off the UI thread). Replaces any previous session. */
  load(samples: Float32Array, sampleRate: number): Promise<Analysis>;
  setNotes(edits: NoteEdit[]): Promise<EditResult>;
  split(index: number, sec: number): Promise<EditResult>;
  merge(index: number): Promise<EditResult>;
  renderAll(): Promise<Float32Array>;
  dispose(): void;
}

export type PitchWorkerRequest =
  | { id: number; type: "load"; samples: Float32Array; sampleRate: number }
  | { id: number; type: "setNotes"; edits: NoteEdit[] }
  | { id: number; type: "split"; index: number; sec: number }
  | { id: number; type: "merge"; index: number }
  | { id: number; type: "renderAll" };

export type PitchWorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** The real engine: a module Web Worker hosting the wasm PitchSession. */
export function createWorkerPitchEngine(): PitchEngine {
  const worker = new Worker(new URL("./pitchWorker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  worker.onmessage = (ev: MessageEvent<PitchWorkerResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "Pitch engine crashed");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  function call<T>(req: DistributiveOmit<PitchWorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...req, id }, transfer);
    });
  }

  return {
    load(samples, sampleRate) {
      // Copy so the caller keeps its buffer; the copy is transferred (zero-copy) to the worker.
      const copy = new Float32Array(samples);
      return call<Analysis>({ type: "load", samples: copy, sampleRate }, [copy.buffer]);
    },
    setNotes: (edits) => call<EditResult>({ type: "setNotes", edits }),
    split: (index, sec) => call<EditResult>({ type: "split", index, sec }),
    merge: (index) => call<EditResult>({ type: "merge", index }),
    renderAll: () => call<Float32Array>({ type: "renderAll" }),
    dispose() {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("Pitch engine disposed"));
      pending.clear();
    },
  };
}

/**
 * Brings the engine back to a snapshot (undo/redo): replays splits/merges until the note boundaries
 * match, then re-applies every note's target/drift/modulation. Returns the final analysis and all
 * re-rendered patches, in order.
 */
export async function restoreSnapshot(engine: PitchEngine, current: Analysis, snapshot: NoteSnapshot[]): Promise<EditResult> {
  let analysis = current;
  const patches: AudioPatch[] = [];
  for (let guard = 0; guard < 256; guard++) {
    const op = nextStructuralOp(analysis.notes, snapshot);
    if (!op) break;
    const r = op.kind === "split" ? await engine.split(op.index, op.sec) : await engine.merge(op.index);
    analysis = r.analysis;
    patches.push(...r.patches);
    if (!r.ok) break;
  }
  const edits: NoteEdit[] = [];
  for (const [index, snap] of matchSnapshot(analysis.notes, snapshot)) {
    const n = analysis.notes[index];
    if (
      Math.abs(n.target - snap.target) > 1e-6 ||
      Math.abs(n.drift - snap.drift) > 1e-6 ||
      Math.abs(n.modulation - snap.modulation) > 1e-6
    ) {
      edits.push({ index, target: snap.target, drift: snap.drift, modulation: snap.modulation });
    }
  }
  if (edits.length > 0) {
    const r = await engine.setNotes(edits);
    analysis = r.analysis;
    patches.push(...r.patches);
  }
  return { ok: true, analysis, patches };
}
