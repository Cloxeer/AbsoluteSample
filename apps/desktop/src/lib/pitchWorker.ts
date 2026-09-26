/**
 * Module Web Worker that owns the pitchcore (Rust -> WebAssembly) PitchSession, so the seconds-long
 * analysis and every re-render run off the UI thread. Messages are handled strictly in order.
 * Protocol: see PitchWorkerRequest / PitchWorkerResponse in ./pitchEngine.
 */
import init, { PitchSession } from "../wasm/pitchcore/pitchcore.js";
import { mergeSpans, type Analysis, type AudioPatch } from "./melodyneEditor";
import type { PitchWorkerRequest, PitchWorkerResponse } from "./pitchEngine";

/** Minimal typing of the dedicated worker global (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<PitchWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let ready: Promise<unknown> | null = null;
let session: PitchSession | null = null;
let analysis: Analysis | null = null;

function readAnalysis(s: PitchSession): Analysis {
  analysis = JSON.parse(s.analysisJson()) as Analysis;
  return analysis;
}

function phraseOf(s: PitchSession, sec: number): [number, number] {
  const b = s.phraseBounds(sec);
  return [b[0], b[1]];
}

function noteMid(i: number): number | null {
  const n = analysis?.notes[i];
  return n ? (n.startSec + n.endSec) / 2 : null;
}

function renderSpans(s: PitchSession, spans: [number, number][]): AudioPatch[] {
  return mergeSpans(spans).map(([a, b]) => ({ startSec: a, samples: s.render(a, b) }));
}

function transfers(patches: AudioPatch[]): Transferable[] {
  return patches.map((p) => p.samples.buffer as ArrayBuffer);
}

async function handle(req: PitchWorkerRequest): Promise<{ result: unknown; transfer: Transferable[] }> {
  if (req.type === "load") {
    ready ??= init();
    await ready;
    session?.free();
    session = null;
    session = new PitchSession(req.samples, req.sampleRate);
    return { result: readAnalysis(session), transfer: [] };
  }
  const s = session;
  if (!s) throw new Error("No audio loaded");
  switch (req.type) {
    case "setNotes": {
      const spans: [number, number][] = [];
      let ok = true;
      for (const e of req.edits) {
        const mid = noteMid(e.index);
        ok = s.setNote(e.index, e.target, e.drift, e.modulation) && ok;
        if (mid !== null) spans.push(phraseOf(s, mid));
      }
      const patches = renderSpans(s, spans);
      return { result: { ok, analysis: readAnalysis(s), patches }, transfer: transfers(patches) };
    }
    case "split": {
      const span = phraseOf(s, req.sec);
      const ok = s.splitNote(req.index, req.sec);
      const patches = renderSpans(s, [span]);
      return { result: { ok, analysis: readAnalysis(s), patches }, transfer: transfers(patches) };
    }
    case "merge": {
      const spans: [number, number][] = [];
      for (const i of [req.index, req.index + 1]) {
        const mid = noteMid(i);
        if (mid !== null) spans.push(phraseOf(s, mid));
      }
      const ok = s.mergeWithNext(req.index);
      const patches = renderSpans(s, spans);
      return { result: { ok, analysis: readAnalysis(s), patches }, transfer: transfers(patches) };
    }
    case "renderAll": {
      const samples = s.renderAll();
      return { result: samples, transfer: [samples.buffer as ArrayBuffer] };
    }
    default:
      throw new Error("Unknown request");
  }
}

async function process(req: PitchWorkerRequest): Promise<void> {
  try {
    const { result, transfer } = await handle(req);
    const msg: PitchWorkerResponse = { id: req.id, ok: true, result };
    scope.postMessage(msg, transfer);
  } catch (err) {
    const msg: PitchWorkerResponse = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
}

// Strictly serial: a request never starts before the previous one (e.g. the async load) finished.
let chain: Promise<void> = Promise.resolve();
scope.onmessage = (ev: MessageEvent<PitchWorkerRequest>) => {
  const req = ev.data;
  chain = chain.then(() => process(req));
};
