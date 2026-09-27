/**
 * Finds how far a harmony take is shifted in time against the lead. Harmonies sing the same words
 * at a different pitch, so we match WHEN syllables start (onset envelopes), not the waveforms.
 * Coarse search at 10 ms on onset envelopes, then refinement at 1 ms on the smoothed log-energy
 * contour (measured on real takes: ~3-6 ms error vs ~10 ms when refining on onset spikes, which
 * pitch-shifting and different vowels smear).
 */

export interface AlignResult {
  /** Seconds to delay `other` so it lines up with `lead` (negative = move it earlier). */
  offsetSec: number;
  /** Peak normalised correlation of the onset envelopes, 0..1 (below ~0.3 = unreliable). */
  confidence: number;
}

/** Onset strength per frame: rise of the log-energy envelope (half-wave rectified), mean-removed. */
export function onsetEnvelope(x: Float32Array, hop: number): Float32Array {
  const frames = Math.floor(x.length / hop);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) e += x[o + i] * x[o + i];
    env[f] = Math.log10(e / hop + 1e-9);
  }
  const on = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f++) {
    on[f] = Math.max(0, env[f] - env[f - 1]);
    mean += on[f];
  }
  mean /= Math.max(1, frames);
  for (let f = 0; f < frames; f++) on[f] -= mean;
  return on;
}

/** Log-energy contour (5 ms window, `hop` step), mean-removed. */
export function energyContour(x: Float32Array, hop: number): Float32Array {
  const win = hop * 5;
  const n = Math.max(0, Math.floor((x.length - win) / hop));
  const e = new Float32Array(n);
  let mean = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) s += x[o + i] * x[o + i];
    e[f] = Math.log10(s / win + 1e-7);
    mean += e[f];
  }
  mean /= Math.max(1, n);
  for (let f = 0; f < n; f++) e[f] -= mean;
  return e;
}

/** Best lag by overlap-normalised correlation (fair between lags with different overlap). */
function bestLagNormalised(a: Float32Array, b: Float32Array, lagMin: number, lagMax: number): number {
  let best = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const t0 = Math.max(0, lag);
    const t1 = Math.min(a.length, b.length + lag);
    if (t1 <= t0) continue;
    let s = 0;
    for (let t = t0; t < t1; t++) s += a[t] * b[t - lag];
    s /= t1 - t0;
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  return best;
}

function bestLag(a: Float32Array, b: Float32Array, lagMin: number, lagMax: number): { lag: number; score: number } {
  let best = { lag: 0, score: -Infinity };
  let na = 0;
  let nb = 0;
  for (const v of a) na += v * v;
  for (const v of b) nb += v * v;
  const norm = Math.sqrt(na * nb) || 1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    // score(lag) = sum_t a[t] * b[t - lag]   (b delayed by lag matches a)
    let s = 0;
    const t0 = Math.max(0, lag);
    const t1 = Math.min(a.length, b.length + lag);
    for (let t = t0; t < t1; t++) s += a[t] * b[t - lag];
    if (s > best.score) best = { lag, score: s };
  }
  return { lag: best.lag, score: best.score / norm };
}

export function estimateOffset(lead: Float32Array, other: Float32Array, sampleRate: number, maxShiftSec = 10): AlignResult {
  const coarseHop = Math.max(1, Math.round(sampleRate / 100));
  const fineHop = Math.max(1, Math.round(sampleRate / 1000));
  const a = onsetEnvelope(lead, coarseHop);
  const b = onsetEnvelope(other, coarseHop);
  const maxLag = Math.round(maxShiftSec * 100);
  const coarse = bestLag(a, b, -maxLag, maxLag);
  const center = Math.round((coarse.lag * coarseHop) / fineHop);
  const fine = bestLagNormalised(energyContour(lead, fineHop), energyContour(other, fineHop), center - 30, center + 30);
  return { offsetSec: (fine * fineHop) / sampleRate, confidence: Math.max(0, Math.min(1, coarse.score)) };
}
