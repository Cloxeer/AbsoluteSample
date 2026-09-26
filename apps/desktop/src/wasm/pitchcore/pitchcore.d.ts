/* tslint:disable */
/* eslint-disable */
export class PitchSession {
  free(): void;
  renderAll(): Float32Array;
  splitNote(idx: number, sec: number): boolean;
  analysisJson(): string;
  /**
   * [start, end] seconds of the phrase containing `sec`.
   */
  phraseBounds(sec: number): Float32Array;
  mergeWithNext(idx: number): boolean;
  /**
   * Analyse mono samples. Takes a few hundred ms per minute of audio.
   */
  constructor(samples: Float32Array, sample_rate: number);
  render(start_sec: number, end_sec: number): Float32Array;
  setNote(idx: number, target: number, drift: number, modulation: number): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_pitchsession_free: (a: number, b: number) => void;
  readonly pitchsession_analysisJson: (a: number) => [number, number];
  readonly pitchsession_mergeWithNext: (a: number, b: number) => number;
  readonly pitchsession_new: (a: number, b: number, c: number) => number;
  readonly pitchsession_phraseBounds: (a: number, b: number) => [number, number];
  readonly pitchsession_render: (a: number, b: number, c: number) => [number, number];
  readonly pitchsession_renderAll: (a: number) => [number, number];
  readonly pitchsession_setNote: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly pitchsession_splitNote: (a: number, b: number, c: number) => number;
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
