import { describe, expect, it } from "vitest";
import { estimateOffset } from "./alignment";

const SR = 44100;

/** A "sung" line: syllables of a harmonic tone at `freq`, with a syllable rhythm shared by all takes. */
function take(freq: number, seconds: number, delaySec: number, seed: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const syllables = [0.3, 0.8, 1.1, 1.7, 2.0, 2.2, 3.1, 3.6, 4.4, 4.9, 5.3, 6.2, 6.5, 7.4];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (const t0 of syllables) {
    const start = Math.round((t0 + delaySec) * SR);
    const len = Math.round(0.28 * SR);
    for (let i = 0; i < len && start + i < n; i++) {
      if (start + i < 0) continue;
      const t = i / SR;
      const env = Math.min(1, t / 0.01) * Math.exp(-3 * t);
      let v = 0;
      for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * freq * k * t) / k;
      out[start + i] += 0.3 * env * v + 0.003 * rnd();
    }
  }
  return out;
}

describe("estimateOffset", () => {
  it.each([0.3721, -0.8453, 0, 2.5019])("finds a harmony shifted by %f s (different pitch) within 2 ms", (delay) => {
    const lead = take(220, 9, 0, 1);
    const harmony = take(277.2, 9, delay, 7); // a major third up, sung on the same rhythm
    const r = estimateOffset(lead, harmony, SR);
    expect(Math.abs(r.offsetSec + delay)).toBeLessThan(0.002);
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it("reports low confidence for unrelated audio", () => {
    const lead = take(220, 9, 0, 1);
    const noise = Float32Array.from({ length: 9 * SR }, (_, i) => 0.1 * Math.sin(i * 0.37) * Math.sin(i * 0.0011));
    expect(estimateOffset(lead, noise, SR).confidence).toBeLessThan(0.3);
  });

  it("is fast enough for full songs (90 s, +-10 s search)", () => {
    const lead = take(220, 90, 0, 1);
    const harm = take(330, 90, 1.234, 3);
    const t0 = performance.now();
    const r = estimateOffset(lead, harm, SR);
    const ms = performance.now() - t0;
    expect(Math.abs(r.offsetSec + 1.234)).toBeLessThan(0.002);
    expect(ms).toBeLessThan(3000);
  });
});
