/**
 * "Studio polish": the vocal chain engineers put on a finished vocal, built from native Web Audio
 * nodes (no DSP in JS, near-zero CPU). Rumble cut, a little less mud, a touch of presence and air,
 * gentle compression so every word sits at the same level, and a short plate-style reverb for depth.
 * Tuning makes the notes right; this makes it sound like a record.
 */

export interface PolishChain {
  input: AudioNode;
  output: AudioNode;
}

type Ctx = BaseAudioContext;

export function supportsPolish(ctx: unknown): ctx is Ctx {
  const c = ctx as Partial<Ctx> | null;
  return !!c && typeof c.createBiquadFilter === "function" && typeof c.createDynamicsCompressor === "function" && typeof c.createConvolver === "function";
}

/** Deterministic plate-like impulse response: decorrelated noise with an exponential tail. */
export function plateImpulse(ctx: Ctx, seconds = 1.4, preDelaySec = 0.018): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(seconds * sr);
  const pre = Math.round(preDelaySec * sr);
  const buf = ctx.createBuffer(2, n, sr);
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff - 0.5;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      // Darker as it decays (one-pole low-pass whose cutoff falls over time).
      const a = Math.min(0.85, 0.25 + t * 0.5);
      lp = lp * a + rnd() * (1 - a);
      d[i] = lp * Math.exp(-t * 4.2) * 2.2;
    }
  }
  return buf;
}

export function buildPolish(ctx: Ctx): PolishChain {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 85;
  hp.Q.value = 0.7;
  const mud = ctx.createBiquadFilter();
  mud.type = "peaking";
  mud.frequency.value = 300;
  mud.Q.value = 1.1;
  mud.gain.value = -2.5;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 3200;
  presence.Q.value = 0.9;
  presence.gain.value = 2;
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 11000;
  air.gain.value = 2.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 8;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.15;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.35;
  const verb = ctx.createConvolver();
  verb.buffer = plateImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.13;
  const output = ctx.createGain();
  input.connect(hp).connect(mud).connect(presence).connect(air).connect(comp).connect(makeup);
  makeup.connect(output);
  makeup.connect(verb).connect(wet).connect(output);
  return { input, output };
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/** Renders channels through the polish chain offline: same channel count, exact same length. */
export async function renderPolished(channels: Float32Array[], sampleRate: number, ctor?: OfflineCtor): Promise<Float32Array[]> {
  const OAC: OfflineCtor | undefined = ctor ?? (typeof window !== "undefined" ? (window.OfflineAudioContext as OfflineCtor | undefined) : undefined);
  const frames = channels[0]?.length ?? 0;
  if (!OAC || frames === 0) return channels;
  const ctx = new OAC(channels.length, frames, sampleRate);
  if (!supportsPolish(ctx)) return channels;
  const buf = ctx.createBuffer(channels.length, frames, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const chain = buildPolish(ctx);
  src.connect(chain.input);
  chain.output.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return Array.from({ length: channels.length }, (_, i) => new Float32Array(rendered.getChannelData(i)).subarray(0, frames));
}
