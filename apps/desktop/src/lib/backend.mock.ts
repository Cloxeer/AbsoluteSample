import { emitMockEngineProgress, emitMockProgress } from "./events";
import type {
  DependencyReport,
  EngineStatus,
  InstrumentGroup,
  InstrumentStem,
  LoopAnalysis,
  LoopInfo,
  SliceInfo,
  StemInfo,
  StemKey,
  TrackInfo,
} from "./types";

const INSTRUMENT_DEFS: { key: string; label: string; group: InstrumentGroup; parent: string | null; order: number; freq: number }[] = [
  { key: "vocals", label: "Vocals", group: "vocals", parent: null, order: 0, freq: 1800 },
  { key: "drums", label: "Drums", group: "drums", parent: null, order: 1, freq: 150 },
  { key: "bass", label: "Bass", group: "bass", parent: null, order: 2, freq: 300 },
  { key: "guitar", label: "Guitar", group: "guitar", parent: null, order: 3, freq: 900 },
  { key: "keys", label: "Keys", group: "keys", parent: null, order: 4, freq: 1200 },
  { key: "other", label: "Other", group: "other", parent: null, order: 5, freq: 2500 },
];

const STEM_DEFS: { index: 1 | 2 | 3 | 4; key: StemKey; label: string; band: string; freq: number; type: "lowpass" | "bandpass" | "highpass" }[] = [
  { index: 1, key: "drums_sub", label: "Drums / Sub", band: "LP 130 Hz (LR4)", freq: 100, type: "lowpass" },
  { index: 2, key: "bass_lowmid", label: "Bass / Low-Mid", band: "HP 130 - LP 800 Hz", freq: 400, type: "bandpass" },
  { index: 3, key: "mid_vocals", label: "Mid / Vocals", band: "HP 800 - LP 4500 Hz", freq: 2000, type: "bandpass" },
  { index: 4, key: "highs_air", label: "Highs / Air", band: "HP 4500 Hz", freq: 8000, type: "highpass" },
];

interface Manifest {
  track: TrackInfo;
  loop: LoopInfo;
  stems: StemInfo[];
  analysis: LoopAnalysis;
}

let cachedManifest: Manifest | null = null;
let cachedWavUrls: Record<string, string> = {};
let cachedInstruments: InstrumentStem[] | null = null;
let cachedEngineInstalled = true;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch("/fixtures/manifest.json");
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

function bufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numChannels * 2 + 44;
  const arrayBuffer = new ArrayBuffer(length);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + buffer.length * numChannels * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, buffer.length * numChannels * 2, true);

  let offset = 44;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

async function synthesizeStemWav(freq: number, type: "lowpass" | "bandpass" | "highpass", durationSec = 15): Promise<string> {
  const sampleRate = 44100;
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * durationSec), sampleRate);
  const bufferSize = ctx.length;
  const noiseBuffer = ctx.createBuffer(2, bufferSize, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = noiseBuffer.getChannelData(ch);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.4;
    }
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = type === "bandpass" ? "bandpass" : type;
  filter.frequency.value = freq;
  filter.Q.value = type === "bandpass" ? 0.7 : 0.9;

  const gain = ctx.createGain();
  gain.gain.value = 0.6;

  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start();

  const rendered = await ctx.startRendering();
  const blob = bufferToWavBlob(rendered);
  return URL.createObjectURL(blob);
}

async function synthesizeSourceWav(durationSec = 45): Promise<string> {
  const sampleRate = 44100;
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * durationSec), sampleRate);
  const noiseBuffer = ctx.createBuffer(2, ctx.length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = noiseBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.3 * Math.sin(i / 5000);
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const blob = bufferToWavBlob(rendered);
  return URL.createObjectURL(blob);
}

function synthesizeAnalysis(bpm: number, durationSec: number): LoopAnalysis {
  const beatGrid: number[] = [];
  const step = 60 / bpm;
  for (let t = 0; t < durationSec; t += step) beatGrid.push(Number(t.toFixed(3)));
  const transients = beatGrid.map((t) => Number((t + (Math.random() * 0.02 - 0.01)).toFixed(3)));
  const frames = Math.floor(durationSec * 86);
  const onsetEnvelope: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / 86;
    const nearBeat = beatGrid.some((b) => Math.abs(b - t) < 0.05);
    onsetEnvelope.push(nearBeat ? 0.7 + Math.random() * 0.3 : Math.random() * 0.15);
  }
  return {
    bpm,
    confidence: 0.87,
    transients,
    beatGrid,
    bars: Math.floor(durationSec / (4 * step)),
    onsetEnvelope,
    peakDb: -1.2,
    rmsDb: -14.5,
  };
}

async function synthesizeManifest(): Promise<Manifest> {
  const durationSec = 45 - 30;
  const trackId = "nRKgT3d6xoE";
  const track: TrackInfo = {
    id: trackId,
    title: "Mock Fixture Track",
    url: "https://youtu.be/nRKgT3d6xoE",
    sourcePath: `mock/${trackId}/source.opus`,
    wavPath: `mock/${trackId}/source.wav`,
    durationSec: 180,
    sampleRate: 44100,
    channels: 2,
    codec: "opus",
    workDir: `mock/${trackId}`,
  };
  const loop: LoopInfo = {
    trackId,
    startSec: 30,
    endSec: 45,
    durationSec,
    loopPath: `mock/${trackId}/loop.opus`,
    wavPath: `mock/${trackId}/loop.wav`,
  };
  const stems: StemInfo[] = STEM_DEFS.map((def) => ({
    index: def.index,
    key: def.key,
    label: def.label,
    band: def.band,
    path: `mock/${trackId}/stems/0${def.index}_${def.key}.wav`,
    bytes: 1_200_000,
    peakDb: -2.5,
    rmsDb: -16.0,
  }));
  const analysis = synthesizeAnalysis(120, durationSec);
  return { track, loop, stems, analysis };
}

async function getManifest(): Promise<Manifest> {
  if (cachedManifest) return cachedManifest;
  const loaded = await loadManifest();
  cachedManifest = loaded ?? (await synthesizeManifest());
  return cachedManifest;
}

async function resolveWavUrl(path: string): Promise<string> {
  if (cachedWavUrls[path]) return cachedWavUrls[path];
  const manifest = await getManifest();
  const fromFixtures = await loadManifest();
  const basename = path.split(/[\\/]/).pop() ?? path;

  if (fromFixtures) {
    const url = `/fixtures/${basename}`;
    cachedWavUrls[path] = url;
    return url;
  }

  // synthesize
  if (path === manifest.track.wavPath) {
    const url = await synthesizeSourceWav(45);
    cachedWavUrls[path] = url;
    return url;
  }
  if (path === manifest.loop.wavPath) {
    const url = await synthesizeSourceWav(manifest.loop.durationSec);
    cachedWavUrls[path] = url;
    return url;
  }
  const stem = manifest.stems.find((s) => s.path === path);
  if (stem) {
    const def = STEM_DEFS.find((d) => d.key === stem.key)!;
    const url = await synthesizeStemWav(def.freq, def.type, manifest.loop.durationSec);
    cachedWavUrls[path] = url;
    return url;
  }
  const instrument = cachedInstruments?.find((s) => s.path === path);
  if (instrument) {
    const def = INSTRUMENT_DEFS.find((d) => d.key === instrument.key);
    const url = await synthesizeStemWav(def?.freq ?? 1000, "bandpass", manifest.loop.durationSec);
    cachedWavUrls[path] = url;
    return url;
  }
  // slice or unknown: fall back to a short synthesized noise
  const url = await synthesizeStemWav(1000, "bandpass", 1);
  cachedWavUrls[path] = url;
  return url;
}

export async function checkDependencies(): Promise<DependencyReport> {
  await delay(150);
  return { ffmpeg: "ffmpeg (mock)", ffprobe: "ffprobe (mock)", ytdlp: "yt-dlp (mock)", ok: true };
}

export async function fetchAudio(_url: string): Promise<TrackInfo> {
  const stages: [string, number, string][] = [
    ["download", 20, "Downloading best audio..."],
    ["download", 60, "Downloading best audio..."],
    ["decode", 85, "Decoding to WAV..."],
    ["decode", 100, "Decode complete"],
  ];
  for (const [stage, percent, message] of stages) {
    await delay(180);
    emitMockProgress({ stage: stage as any, percent, message });
  }
  const manifest = await getManifest();
  return manifest.track;
}

export async function trimLoop(_args: { trackId: string; startSec: number; endSec: number }): Promise<LoopInfo> {
  emitMockProgress({ stage: "trim", percent: 40, message: "Trimming loop..." });
  await delay(200);
  emitMockProgress({ stage: "trim", percent: 100, message: "Loop trimmed" });
  const manifest = await getManifest();
  return { ...manifest.loop, startSec: _args.startSec, endSec: _args.endSec, durationSec: _args.endSec - _args.startSec };
}

export async function separateStems(_args: { trackId: string }): Promise<StemInfo[]> {
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    await delay(220);
    emitMockProgress({ stage: "stems", percent: Math.round((i / steps) * 100), message: `Rendering stem ${i}/4...` });
  }
  const manifest = await getManifest();
  return manifest.stems;
}

export async function analyzeLoop(_args: { trackId: string }): Promise<LoopAnalysis> {
  emitMockProgress({ stage: "analyze", percent: 50, message: "Analyzing onsets..." });
  await delay(250);
  emitMockProgress({ stage: "analyze", percent: 100, message: "Analysis complete" });
  const manifest = await getManifest();
  return manifest.analysis;
}

export async function saveStem(args: { srcPath: string; destPath: string }): Promise<string> {
  const url = await resolveWavUrl(args.srcPath);
  const a = document.createElement("a");
  a.href = url;
  a.download = args.destPath.split(/[\\/]/).pop() ?? "stem.wav";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return args.destPath;
}

export async function saveAllStems(args: { trackId: string; destDir: string }): Promise<string[]> {
  const manifest = await getManifest();
  const paths: string[] = [];
  for (const stem of manifest.stems) {
    const basename = stem.path.split(/[\\/]/).pop() ?? `${stem.key}.wav`;
    const destPath = `${args.destDir}/${basename}`;
    await saveStem({ srcPath: stem.path, destPath });
    paths.push(destPath);
  }
  return paths;
}

export async function openWorkDir(_args: { trackId: string }): Promise<void> {
  await delay(50);
}

export async function sliceBeats(args: { trackId: string; stemKey: StemKey | null; bpm: number; divisions: number }): Promise<SliceInfo[]> {
  emitMockProgress({ stage: "slice", percent: 40, message: "Slicing to beats..." });
  await delay(200);
  const manifest = await getManifest();
  const step = 60 / args.bpm;
  const barLen = step * 4;
  const beatLen = barLen / args.divisions;
  const slices: SliceInfo[] = [];
  const total = Math.max(1, Math.floor(manifest.loop.durationSec / beatLen));
  for (let i = 0; i < total; i++) {
    const startSec = Number((i * beatLen).toFixed(3));
    const endSec = Number(Math.min(manifest.loop.durationSec, (i + 1) * beatLen).toFixed(3));
    slices.push({
      index: i,
      startSec,
      endSec,
      path: `mock/${args.trackId}/stems/slices/${args.stemKey ?? "loop"}_slice_${String(i).padStart(2, "0")}.wav`,
    });
  }
  emitMockProgress({ stage: "slice", percent: 100, message: "Slicing complete" });
  return slices;
}

export async function resolveWav(path: string): Promise<string> {
  return resolveWavUrl(path);
}

export async function engineStatus(): Promise<EngineStatus> {
  await delay(120);
  return {
    installed: cachedEngineInstalled,
    pythonFound: true,
    pythonPath: "mock",
    venvPath: "mock",
    torchVersion: cachedEngineInstalled ? "2.4.0+cu124" : null,
    cuda: true,
    gpuName: cachedEngineInstalled ? "Mock GPU" : null,
    modelsPresent: cachedEngineInstalled ? ["htdemucs_6s"] : [],
    enginePath: "mock/engine",
  };
}

export async function engineInstall(): Promise<EngineStatus> {
  const stages: ["python" | "venv" | "torch" | "separator" | "verify", number, string][] = [
    ["python", 10, "Locating Python 3.12"],
    ["venv", 30, "Creating virtual environment"],
    ["torch", 60, "Installing PyTorch with CUDA"],
    ["separator", 85, "Installing audio-separator"],
    ["verify", 100, "Verifying installation"],
  ];
  for (const [stage, percent, message] of stages) {
    await delay(180);
    emitMockEngineProgress({ stage, percent, message });
  }
  cachedEngineInstalled = true;
  return engineStatus();
}

function synthesizeInstruments(trackId: string): InstrumentStem[] {
  const stems: InstrumentStem[] = INSTRUMENT_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    group: def.group,
    parent: def.parent,
    path: `mock/${trackId}/instruments/${def.key}.wav`,
    bytes: 1_400_000,
    peakDb: -2.0,
    rmsDb: -15.0,
    model: "htdemucs_6s",
    order: def.order,
  }));
  const kitParts: [string, number][] = [
    ["kick", 0],
    ["snare", 1],
    ["toms", 2],
    ["hihat", 3],
    ["ride", 4],
    ["crash", 5],
  ];
  for (const [name, order] of kitParts) {
    stems.push({
      key: `drums_${name}`,
      label: name[0].toUpperCase() + name.slice(1),
      group: "drums",
      parent: "drums",
      path: `mock/${trackId}/instruments/drums_${name}.wav`,
      bytes: 400_000,
      peakDb: -3.0,
      rmsDb: -18.0,
      model: "htdemucs_6s (drums pass)",
      order,
    });
  }
  const vocalParts: [string, string, number][] = [
    ["lead", "Lead vocal", 0],
    ["backing", "Backing vocal", 1],
  ];
  for (const [name, label, order] of vocalParts) {
    stems.push({
      key: `vocals_${name}`,
      label,
      group: "vocals",
      parent: "vocals",
      path: `mock/${trackId}/instruments/vocals_${name}.wav`,
      bytes: 500_000,
      peakDb: -2.5,
      rmsDb: -16.0,
      model: "BS-Roformer (lead/backing pass)",
      order,
    });
  }
  return stems;
}

export async function separateInstruments(args: { trackId: string }): Promise<InstrumentStem[]> {
  const mockFail = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mockfail") === "1";
  const passes: { pass: string; message: string }[] = [
    { pass: "instruments", message: "Separating instruments (Demucs)..." },
    { pass: "vocals", message: "Refining vocals..." },
    { pass: "lead", message: "Splitting lead and backing vocals..." },
    { pass: "drums", message: "Splitting drum kit..." },
  ];
  for (let i = 0; i < passes.length; i++) {
    const { pass, message } = passes[i];
    await delay(260);
    const failThis = mockFail && pass === "drums";
    emitMockProgress({
      stage: "separate",
      pass,
      percent: Math.round(((i + 1) / passes.length) * 100),
      message: failThis ? "GPU out of memory" : message,
      failed: failThis,
    });
  }

  let stems: InstrumentStem[];
  const fromFixtures = await loadManifest();
  if (fromFixtures && (fromFixtures as any).instruments) {
    stems = (fromFixtures as any).instruments as InstrumentStem[];
  } else {
    stems = synthesizeInstruments(args.trackId);
  }
  cachedInstruments = stems;
  return stems;
}
