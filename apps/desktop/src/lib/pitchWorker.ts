/**
 * Module Web Worker that owns the pitchcore (Rust -> WebAssembly) PitchSession, so the seconds-long
 * analysis and every re-render run off the UI thread. Messages are handled strictly in order.
 * Protocol: see PitchWorkerRequest / PitchWorkerResponse in ./pitchEngine.
 */
import init, { PitchSession } from "../wasm/pitchcore/pitchcore.js";
import { mergeSpans, type Analysis, type AudioPatch } from "./melodyneEditor";
import type { PitchWorkerRequest, PitchWorkerResponse } from "./pitchEngine";
import { expandSpans, flattenWarps, segmentBounds, type WarpSegment } from "./timeWarp";

/** Minimal typing of the dedicated worker global (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<PitchWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let ready: Promise<unknown> | null = null;
let session: PitchSession | null = null;
let analysis: Analysis | null = null;
/** Timing edits currently applied in the session. */
let warps: WarpSegment[] = [];

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
  const nch = s.channelCount();
  // A warped phrase is rebuilt whole, so an edit inside it re-renders the whole segment.
  return mergeSpans(expandSpans(mergeSpans(spans), warps)).map(([a, b]) => ({
    startSec: a,
    samples: s.render(a, b),
    // The original channels (e.g. stereo), rendered with the same shift map as the mono analysis.
    ...(nch > 0 ? { channels: Array.from({ length: nch }, (_, c) => s.renderChannel(c, a, b)) } : {}),
  }));
}

function transfers(patches: AudioPatch[]): Transferable[] {
  return patches.flatMap((p) => [p.samples.buffer as ArrayBuffer, ...(p.channels ?? []).map((c) => c.buffer as ArrayBuffer)]);
}

async function handle(req: PitchWorkerRequest): Promise<{ result: unknown; transfer: Transferable[] }> {
  if (req.type === "load") {
    ready ??= init();
    await ready;
    session?.free();
    session = null;
    session = new PitchSession(req.samples, req.sampleRate);
    warps = [];
    if (req.channels && req.channels.length > 0 && !session.setChannels(req.channels[0], req.channels[1] ?? null)) {
      throw new Error("Channel lengths do not match the audio");
    }
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
    case "setWarps": {
      const spans: [number, number][] = [...warps, ...req.segments].map(segmentBounds);
      const ok = s.setWarps(flattenWarps(req.segments));
      if (ok) warps = req.segments.map((w) => ({ anchors: w.anchors.map(([o, i]) => [o, i] as [number, number]) }));
      const patches = ok ? renderSpans(s, spans) : [];
      return { result: { ok, analysis: readAnalysis(s), patches }, transfer: transfers(patches) };
    }
    case "renderAll": {
      const samples = s.renderAll();
      return { result: samples, transfer: [samples.buffer as ArrayBuffer] };
    }
    case "renderAllChannels": {
      // End past the last sample: the engine clamps to the exact input length.
      const end = (analysis?.durationSec ?? 0) + 1;
      const nch = s.channelCount();
      const chans = nch > 0 ? Array.from({ length: nch }, (_, c) => s.renderChannel(c, 0, end)) : [s.renderAll()];
      return { result: chans, transfer: chans.map((c) => c.buffer as ArrayBuffer) };
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
