import { emitMockEngineProgress, emitMockProgress } from "./events";
import type {
  CutRegionResult,
  DependencyReport,
  EngineStatus,
  InstrumentGroup,
  InstrumentStem,
  LibraryEntry,
  LoopAnalysis,
  LoopInfo,
  RegionParams,
  Sample,
  SliceInfo,
  StemInfo,
  StemKey,
  TrackInfo,
  TrackSession,
  TrashEntry,
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

/** Deterministic string hash -> seeded pseudo-random peaks array, so tests stay fast and repeatable. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Synthesizes a plausible, deterministic 1000-point peaks array (0..1) seeded from a string key. */
function synthesizePeaks(key: string, points = 1000): number[] {
  const rand = seededRandom(hashString(key));
  const peaks: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / points;
    const base = 0.35 + 0.25 * Math.sin(t * Math.PI * 8) + 0.15 * Math.sin(t * Math.PI * 37 + rand() * 6);
    const noise = (rand() - 0.5) * 0.2;
    peaks.push(Math.max(0, Math.min(1, base + noise)));
  }
  return peaks;
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

/** Fallback used when the Web Audio API (OfflineAudioContext) isn't available, e.g. in a jsdom test environment. */
function fallbackSilentWavUrl(durationSec: number): string {
  const sampleRate = 44100;
  const numChannels = 2;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const dataBytes = length * numChannels * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(arrayBuffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
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
  view.setUint32(40, dataBytes, true);
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }
  // Environments without URL.createObjectURL (e.g. jsdom in tests): inline as a data URI.
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return `data:audio/wav;base64,${base64}`;
}

function hasWebAudio(): boolean {
  return (
    typeof OfflineAudioContext !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

async function synthesizeStemWav(freq: number, type: "lowpass" | "bandpass" | "highpass", durationSec = 15): Promise<string> {
  if (!hasWebAudio()) return fallbackSilentWavUrl(durationSec);
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
  if (!hasWebAudio()) return fallbackSilentWavUrl(durationSec);
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
    peaks: synthesizePeaks(`mock/${trackId}/stems/0${def.index}_${def.key}.wav`),
    durationSec,
  }));
  const analysis = synthesizeAnalysis(120, durationSec);
  track.peaks = synthesizePeaks(track.wavPath);
  loop.peaks = synthesizePeaks(loop.wavPath);
  return { track, loop, stems, analysis };
}

/** Fixture manifests predate peaks/tags: fill in synthesized peaks + durationSec where missing. */
function withPeaks<T extends { peaks?: number[]; durationSec?: number }>(obj: T, key: string, durationSec: number): T {
  const peaks = obj.peaks && obj.peaks.length > 0 ? obj.peaks : synthesizePeaks(key);
  return { ...obj, peaks, durationSec: obj.durationSec && obj.durationSec > 0 ? obj.durationSec : durationSec };
}

const GUITAR_TAGS = [
  { label: "Violin, fiddle", score: 0.62 },
  { label: "Bowed string instrument", score: 0.55 },
  { label: "Guitar", score: 0.21 },
];

const GUITAR_DETECTIONS = [
  { label: "Cello", score: 0.22 },
  { label: "Bowed string instrument", score: 0.15 },
  { label: "Violin", score: 0.11 },
];

const GUITAR_CONFIDENCE = { score: 0.64, reasons: ["strong Cello tag 0.22", "some leakage into Other 0.31"] };

function decorateInstruments(stems: InstrumentStem[], loopDurationSec: number): InstrumentStem[] {
  return stems.map((s) => {
    const out = withPeaks(s, s.path, loopDurationSec);
    if (s.key === "guitar" || (s.group === "guitar" && s.parent === null)) {
      return {
        ...out,
        soundsLike: out.soundsLike ?? "Strings",
        tags: out.tags && out.tags.length > 0 ? out.tags : GUITAR_TAGS,
        displayLabel: out.displayLabel ?? "Strings",
        detections: out.detections && out.detections.length > 0 ? out.detections : GUITAR_DETECTIONS,
        confidence: out.confidence ?? GUITAR_CONFIDENCE,
      };
    }
    if (s.key === "other" || (s.group === "other" && s.parent === null)) {
      return { ...out, displayLabel: out.displayLabel ?? "Accordion" };
    }
    return out;
  });
}

type ManifestWithInstruments = Manifest & { instruments?: InstrumentStem[] };

function normalizeManifest(m: ManifestWithInstruments): ManifestWithInstruments {
  const loopDur = m.loop.durationSec > 0 ? m.loop.durationSec : m.loop.endSec - m.loop.startSec;
  return {
    ...m,
    track: withPeaks(m.track, m.track.wavPath, m.track.durationSec),
    loop: withPeaks({ ...m.loop, durationSec: loopDur }, m.loop.wavPath, loopDur),
    stems: m.stems.map((s) => withPeaks(s, s.path, loopDur)),
    instruments: m.instruments ? decorateInstruments(m.instruments, loopDur) : undefined,
  };
}

async function getManifest(): Promise<Manifest> {
  if (cachedManifest) return cachedManifest;
  const loaded = await loadManifest();
  cachedManifest = normalizeManifest(loaded ?? (await synthesizeManifest()));
  return cachedManifest;
}

// v3 addendum: in-memory song library

interface LibraryRecord {
  entry: LibraryEntry;
  track: TrackInfo;
  loop: LoopInfo | null;
  stems: StemInfo[] | null;
  instruments: InstrumentStem[] | null;
  analysis: LoopAnalysis | null;
}

let libraryStore: Map<string, LibraryRecord> | null = null;
let sampleStore: Sample[] = [];
const MAX_SCANS = 3;

interface TrashRecord {
  entry: TrashEntry;
  restoreTrack?: { id: string; rec: LibraryRecord };
  restoreSample?: Sample;
}
let trashStore: TrashRecord[] = [];
let engineBusyTrackId: string | null = null;

function estimateBytes(durationSec: number, hasLoop: boolean, hasBands: boolean, hasInstruments: boolean): number {
  const pcmBytesPerSec = 44100 * 2 * 2;
  let bytes = durationSec * pcmBytesPerSec * 0.3; // compressed source approximation
  if (hasLoop) bytes += 15 * pcmBytesPerSec;
  if (hasBands) bytes += 4 * 15 * pcmBytesPerSec;
  if (hasInstruments) bytes += 6 * 15 * pcmBytesPerSec;
  return Math.round(bytes);
}

async function seedLibrary(): Promise<Map<string, LibraryRecord>> {
  const manifest = await getManifest();
  const now = Date.now();

  const store = new Map<string, LibraryRecord>();

  const seedTrack = manifest.track;
  const seedEntry: LibraryEntry = {
    id: seedTrack.id,
    title: seedTrack.title,
    url: seedTrack.url,
    durationSec: seedTrack.durationSec,
    fetchedAt: new Date(now - 60_000).toISOString(),
    lastOpenedAt: new Date(now - 60_000).toISOString(),
    kept: true,
    hasLoop: true,
    loopStartSec: manifest.loop.startSec,
    loopEndSec: manifest.loop.endSec,
    hasBands: true,
    hasInstruments: false,
    instrumentCount: 0,
    bytes: estimateBytes(seedTrack.durationSec, true, true, false),
  };
  store.set(seedTrack.id, {
    entry: seedEntry,
    track: seedTrack,
    loop: manifest.loop,
    stems: manifest.stems,
    instruments: null,
    analysis: manifest.analysis,
  });

  // Extra fake entry: unkept, fetch-only (no loop, no bands, no instruments).
  const songTwoId = "ZAz3rnLGthg";
  const songTwoTrack: TrackInfo = {
    id: songTwoId,
    title: "Song two",
    url: `https://youtu.be/${songTwoId}`,
    sourcePath: `mock/${songTwoId}/source.opus`,
    wavPath: `mock/${songTwoId}/source.wav`,
    durationSec: 214,
    sampleRate: 44100,
    channels: 2,
    codec: "opus",
    workDir: `mock/${songTwoId}`,
  };
  store.set(songTwoId, {
    entry: {
      id: songTwoId,
      title: "Song two",
      url: songTwoTrack.url,
      durationSec: songTwoTrack.durationSec,
      fetchedAt: new Date(now - 40_000).toISOString(),
      lastOpenedAt: new Date(now - 40_000).toISOString(),
      kept: false,
      hasLoop: false,
      loopStartSec: null,
      loopEndSec: null,
      hasBands: false,
      hasInstruments: false,
      instrumentCount: 0,
      bytes: estimateBytes(songTwoTrack.durationSec, false, false, false),
    },
    track: songTwoTrack,
    loop: null,
    stems: null,
    instruments: null,
    analysis: null,
  });

  // Extra fake entry: loop only, unkept (demonstrates pruning of loop-only songs with no split).
  const songThreeId = "XEolg577-DA";
  const songThreeTrack: TrackInfo = {
    id: songThreeId,
    title: "Song three",
    url: `https://youtu.be/${songThreeId}`,
    sourcePath: `mock/${songThreeId}/source.opus`,
    wavPath: `mock/${songThreeId}/source.wav`,
    durationSec: 198,
    sampleRate: 44100,
    channels: 2,
    codec: "opus",
    workDir: `mock/${songThreeId}`,
  };
  const songThreeLoop: LoopInfo = {
    trackId: songThreeId,
    startSec: 30,
    endSec: 45,
    durationSec: 15,
    loopPath: `mock/${songThreeId}/loop.opus`,
    wavPath: `mock/${songThreeId}/loop.wav`,
  };
  store.set(songThreeId, {
    entry: {
      id: songThreeId,
      title: "Song three",
      url: songThreeTrack.url,
      durationSec: songThreeTrack.durationSec,
      fetchedAt: new Date(now - 20_000).toISOString(),
      lastOpenedAt: new Date(now - 20_000).toISOString(),
      kept: false,
      hasLoop: true,
      loopStartSec: songThreeLoop.startSec,
      loopEndSec: songThreeLoop.endSec,
      hasBands: false,
      hasInstruments: false,
      instrumentCount: 0,
      bytes: estimateBytes(songThreeTrack.durationSec, true, false, false),
    },
    track: songThreeTrack,
    loop: songThreeLoop,
    stems: null,
    instruments: null,
    analysis: null,
  });

  return store;
}

async function getLibraryStore(): Promise<Map<string, LibraryRecord>> {
  if (!libraryStore) libraryStore = await seedLibrary();
  return libraryStore;
}

/** v4: keeps only the MAX_SCANS most recently opened unkept ("scan") entries; kept entries are never pruned. */
function pruneUnkept(store: Map<string, LibraryRecord>, exceptIds: string[]): void {
  const unkept = Array.from(store.entries()).filter(([id, rec]) => !rec.entry.kept && !exceptIds.includes(id));
  unkept.sort((a, b) => (a[1].entry.lastOpenedAt < b[1].entry.lastOpenedAt ? 1 : -1));
  for (const [id] of unkept.slice(MAX_SCANS)) {
    store.delete(id);
  }
}

function synthesizeSessionForEntry(rec: LibraryRecord): TrackSession {
  const loopDur = rec.loop ? (rec.loop.durationSec > 0 ? rec.loop.durationSec : rec.loop.endSec - rec.loop.startSec) : 15;
  return {
    track: withPeaks(rec.track, rec.track.wavPath, rec.track.durationSec),
    loop: rec.loop ? withPeaks(rec.loop, rec.loop.wavPath, loopDur) : null,
    stems: rec.stems ? rec.stems.map((s) => withPeaks(s, s.path, loopDur)) : null,
    instruments: rec.instruments ? decorateInstruments(rec.instruments, loopDur) : null,
    analysis: rec.analysis,
  };
}

/** Checks that a fixture actually exists as real WAV bytes, since a dev server's SPA history fallback can
 *  answer an unmatched /fixtures/<x> path with a 200 OK index.html instead of a 404. */
async function fixtureExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) return false;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 12) return false;
    const header = new TextDecoder("ascii").decode(new Uint8Array(buf, 0, 4));
    return header === "RIFF";
  } catch {
    return false;
  }
}

async function resolveWavUrl(path: string): Promise<string> {
  if (cachedWavUrls[path]) return cachedWavUrls[path];
  const manifest = await getManifest();
  const fromFixtures = await loadManifest();
  const basename = path.split(/[\\/]/).pop() ?? path;

  if (fromFixtures) {
    // Instrument stems live under /fixtures/instruments/<key>.wav, everything else at the top level.
    const candidates = [`/fixtures/${basename}`, `/fixtures/instruments/${basename}`];
    for (const url of candidates) {
      if (await fixtureExists(url)) {
        cachedWavUrls[path] = url;
        return url;
      }
    }
    // Neither candidate exists on disk: fall through to synthesizing audio instead of returning a dead URL.
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

function extractVideoId(url: string): string {
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // fallback: crude hash so repeated unknown urls resolve to the same fake id
  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `mock${Math.abs(hash)}`;
}

export async function fetchAudio(args: { url: string; force?: boolean; currentTrackId?: string }): Promise<TrackInfo> {
  const store = await getLibraryStore();
  const id = extractVideoId(args.url);
  const exceptIds = [id, ...(args.currentTrackId ? [args.currentTrackId] : [])];

  const cached = store.get(id);
  if (cached && !args.force) {
    pruneUnkept(store, exceptIds);
    return withPeaks(cached.track, cached.track.wavPath, cached.track.durationSec);
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const stages: [string, number, string][] = [
    ["download", 20, "Downloading best audio..."],
    ["download", 60, "Downloading best audio..."],
    ["decode", 85, "Decoding to WAV..."],
    ["decode", 100, "Decode complete"],
  ];
  for (const [stage, percent, message] of stages) {
    await delay(180);
    emitMockProgress({
      stage: stage as any,
      percent,
      message,
      trackId: id,
      startedAt,
      elapsedSec: (Date.now() - startedMs) / 1000,
    });
  }

  pruneUnkept(store, exceptIds);

  if (cached) {
    // force re-fetch of an existing entry: reset its split state per fresh download semantics.
    const now = new Date().toISOString();
    cached.entry = { ...cached.entry, fetchedAt: now, lastOpenedAt: now };
    return withPeaks(cached.track, cached.track.wavPath, cached.track.durationSec);
  }

  const manifest = await getManifest();
  const now = new Date().toISOString();
  const track: TrackInfo = {
    id,
    title: `Fetched track ${id}`,
    url: args.url,
    sourcePath: `mock/${id}/source.opus`,
    wavPath: manifest.track.wavPath,
    durationSec: manifest.track.durationSec,
    sampleRate: 44100,
    channels: 2,
    codec: "opus",
    workDir: `mock/${id}`,
    peaks: manifest.track.peaks,
  };
  store.set(id, {
    entry: {
      id,
      title: track.title,
      url: track.url,
      durationSec: track.durationSec,
      fetchedAt: now,
      lastOpenedAt: now,
      kept: false,
      hasLoop: false,
      loopStartSec: null,
      loopEndSec: null,
      hasBands: false,
      hasInstruments: false,
      instrumentCount: 0,
      bytes: estimateBytes(track.durationSec, false, false, false),
    },
    track,
    loop: null,
    stems: null,
    instruments: null,
    analysis: null,
  });
  return track;
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const store = await getLibraryStore();
  return Array.from(store.values())
    .map((r) => r.entry)
    .sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
}

export async function openTrack(trackId: string): Promise<TrackSession> {
  const store = await getLibraryStore();
  const rec = store.get(trackId);
  if (!rec) throw new Error(`Unknown track: ${trackId}`);
  rec.entry = { ...rec.entry, lastOpenedAt: new Date().toISOString() };
  return synthesizeSessionForEntry(rec);
}

export async function setKept(trackId: string, kept: boolean): Promise<LibraryEntry> {
  const store = await getLibraryStore();
  const rec = store.get(trackId);
  if (!rec) throw new Error(`Unknown track: ${trackId}`);
  rec.entry = { ...rec.entry, kept };
  return rec.entry;
}

export async function deleteTrack(trackId: string): Promise<void> {
  const store = await getLibraryStore();
  const rec = store.get(trackId);
  if (rec) {
    trashStore = [
      { entry: { id: trackId, kind: "track", name: rec.entry.title, deletedAt: new Date().toISOString(), bytes: rec.entry.bytes }, restoreTrack: { id: trackId, rec } },
      ...trashStore,
    ];
  }
  store.delete(trackId);
}

export async function librarySize(): Promise<{ bytes: number; tracks: number; scans: number; samplesBytes: number; trashBytes: number }> {
  const store = await getLibraryStore();
  const values = Array.from(store.values());
  return {
    bytes: values.reduce((sum, r) => sum + r.entry.bytes, 0),
    tracks: values.length,
    scans: values.filter((r) => !r.entry.kept).length,
    samplesBytes: sampleStore.reduce((sum, s) => sum + s.bytes, 0),
    trashBytes: trashStore.reduce((sum, t) => sum + t.entry.bytes, 0),
  };
}

export async function listTrash(): Promise<TrashEntry[]> {
  return trashStore.map((t) => t.entry);
}

export async function restoreTrash(args: { id: string }): Promise<void> {
  const t = trashStore.find((x) => x.entry.id === args.id);
  if (!t) return;
  if (t.restoreTrack) {
    const store = await getLibraryStore();
    store.set(t.restoreTrack.id, t.restoreTrack.rec);
  }
  if (t.restoreSample) {
    sampleStore = [t.restoreSample, ...sampleStore];
  }
  trashStore = trashStore.filter((x) => x.entry.id !== args.id);
}

export async function emptyTrash(): Promise<void> {
  trashStore = [];
}

export async function clearScans(): Promise<void> {
  const store = await getLibraryStore();
  for (const [id, rec] of Array.from(store.entries())) {
    if (!rec.entry.kept) store.delete(id);
  }
}

export async function trimLoop(_args: { trackId: string; startSec: number; endSec: number }): Promise<LoopInfo> {
  emitMockProgress({ stage: "trim", percent: 40, message: "Trimming loop..." });
  await delay(200);
  emitMockProgress({ stage: "trim", percent: 100, message: "Loop trimmed" });
  const manifest = await getManifest();
  const loop = { ...manifest.loop, trackId: _args.trackId, startSec: _args.startSec, endSec: _args.endSec, durationSec: _args.endSec - _args.startSec };
  const store = await getLibraryStore();
  const rec = store.get(_args.trackId);
  if (rec) {
    rec.loop = loop;
    rec.entry = { ...rec.entry, hasLoop: true, loopStartSec: loop.startSec, loopEndSec: loop.endSec };
  }
  return loop;
}

export async function separateStems(_args: { trackId: string }): Promise<StemInfo[]> {
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    await delay(220);
    emitMockProgress({ stage: "stems", percent: Math.round((i / steps) * 100), message: `Rendering stem ${i}/4...` });
  }
  const manifest = await getManifest();
  const stems = manifest.stems;
  const store = await getLibraryStore();
  const rec = store.get(_args.trackId);
  if (rec) {
    rec.stems = stems;
    rec.entry = { ...rec.entry, hasBands: true };
  }
  return stems;
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
    busy: engineBusyTrackId !== null,
    busyTrackId: engineBusyTrackId,
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

export async function analyzeFile(args: { path: string }): Promise<LoopAnalysis> {
  await delay(120);
  const bpm = 100 + (hashString(args.path) % 40);
  return synthesizeAnalysis(bpm, 15);
}

export async function separateInstruments(args: { trackId: string; passes?: string[]; lowPriority?: boolean }): Promise<{ stems: InstrumentStem[]; elapsedSec: number; passSeconds: Record<string, number>; device: string; failedPasses: string[] }> {
  engineBusyTrackId = args.trackId;
  const mockFail = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mockfail") === "1";
  const passes: { pass: string; message: string }[] = [
    { pass: "instruments", message: "Separating instruments (Demucs)..." },
    { pass: "vocals", message: "Refining vocals..." },
    { pass: "lead", message: "Splitting lead and backing vocals..." },
    { pass: "drums", message: "Splitting drum kit..." },
  ];
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const passSeconds: Record<string, number> = {};
  const failedPasses: string[] = [];
  let lastPassMs = startedMs;
  for (let i = 0; i < passes.length; i++) {
    const { pass, message } = passes[i];
    await delay(260);
    const failThis = mockFail && pass === "drums";
    if (failThis) failedPasses.push(pass);
    const nowMs = Date.now();
    passSeconds[pass] = (nowMs - lastPassMs) / 1000;
    lastPassMs = nowMs;
    emitMockProgress({
      stage: "separate",
      pass,
      percent: Math.round(((i + 1) / passes.length) * 100),
      message: failThis ? "GPU out of memory" : message,
      failed: failThis,
      trackId: args.trackId,
      startedAt,
      elapsedSec: (nowMs - startedMs) / 1000,
      passSeconds: { ...passSeconds },
    });
  }

  const manifest = (await getManifest()) as ManifestWithInstruments;
  const stems = decorateInstruments(manifest.instruments ?? synthesizeInstruments(args.trackId), manifest.loop.durationSec);
  cachedInstruments = stems;

  const elapsedSec = (Date.now() - startedMs) / 1000;
  const store = await getLibraryStore();
  const rec = store.get(args.trackId);
  if (rec) {
    rec.instruments = stems;
    rec.entry = { ...rec.entry, hasInstruments: true, instrumentCount: stems.length };
  }
  engineBusyTrackId = null;
  return { stems, elapsedSec, passSeconds, device: "cpu (mock)", failedPasses };
}

// v4 addendum: samples

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function findSampleSource(rec: LibraryRecord, stemKey: string): { path: string; label: string; group: string } | null {
  if (stemKey === "loop") {
    if (!rec.loop) return null;
    return { path: rec.loop.wavPath, label: "Loop", group: "loop" };
  }
  const band = rec.stems?.find((s) => s.key === stemKey);
  if (band) return { path: band.path, label: band.label, group: "band" };
  const instrument = rec.instruments?.find((s) => s.key === stemKey);
  if (instrument) return { path: instrument.path, label: instrument.label, group: instrument.group };
  return null;
}

function snapRegion(startSec: number, endSec: number, snap: "none" | "beat" | "bar", analysis: LoopAnalysis | null): { startSec: number; endSec: number; bars: number | null } {
  if (snap === "none" || !analysis || analysis.beatGrid.length === 0) {
    return { startSec, endSec, bars: null };
  }
  const grid = analysis.beatGrid;
  const nearest = (t: number) => grid.reduce((best, g) => (Math.abs(g - t) < Math.abs(best - t) ? g : best), grid[0]);
  let snappedStart = nearest(startSec);
  let snappedEnd = nearest(endSec);
  if (snap === "bar") {
    const barLen = (60 / analysis.bpm) * 4;
    snappedStart = Math.round(snappedStart / barLen) * barLen;
    snappedEnd = Math.round(snappedEnd / barLen) * barLen;
  }
  if (snappedEnd <= snappedStart) snappedEnd = snappedStart + 60 / analysis.bpm;
  const barLen = (60 / analysis.bpm) * 4;
  const bars = Math.max(1, Math.round((snappedEnd - snappedStart) / barLen));
  return { startSec: Number(snappedStart.toFixed(3)), endSec: Number(snappedEnd.toFixed(3)), bars };
}

export async function cutRegion(args: { trackId: string; stemKey: string; startSec: number; endSec: number; snap: "none" | "beat" | "bar"; fadeMs?: number; trimLeadingSilence?: boolean }): Promise<CutRegionResult> {
  const store = await getLibraryStore();
  const rec = store.get(args.trackId);
  if (!rec) throw new Error(`Unknown track: ${args.trackId}`);
  const source = findSampleSource(rec, args.stemKey);
  if (!source) throw new Error(`Unknown stem: ${args.stemKey}`);
  const { startSec, endSec, bars } = snapRegion(args.startSec, args.endSec, args.snap, rec.analysis);
  await delay(80);
  return {
    path: `${source.path}#cut_${startSec}-${endSec}`,
    startSec,
    endSec,
    bars,
    peaks: synthesizePeaks(`${source.path}|cut|${startSec}|${endSec}`),
    durationSec: endSec - startSec,
  };
}

export async function sliceHits(args: { trackId: string; stemKey: string; minGapMs?: number; maxHits?: number }): Promise<Sample[]> {
  const store = await getLibraryStore();
  const rec = store.get(args.trackId);
  if (!rec) throw new Error(`Unknown track: ${args.trackId}`);
  const source = findSampleSource(rec, args.stemKey);
  if (!source) throw new Error(`Unknown stem: ${args.stemKey}`);
  const grid = rec.analysis?.transients ?? rec.analysis?.beatGrid ?? [0, 0.5, 1, 1.5];
  const maxHits = Math.min(args.maxHits ?? 64, 64);
  const hits: Sample[] = [];
  for (let i = 0; i < Math.min(grid.length, maxHits); i++) {
    const startSec = grid[i];
    const endSec = i + 1 < grid.length ? Math.min(grid[i + 1], startSec + 1) : startSec + 1;
    const id = `hit_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
    hits.push({
      id,
      name: `${source.label} hit ${String(i + 1).padStart(2, "0")}`,
      path: `${source.path}#hit_${i}`,
      bytes: 60_000,
      songId: args.trackId,
      songTitle: rec.entry.title,
      stemKey: args.stemKey,
      stemLabel: source.label,
      group: source.group,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      bpm: rec.analysis?.bpm ?? null,
      createdAt: new Date().toISOString(),
      peaks: synthesizePeaks(`${source.path}|hit|${i}`),
      kind: "hit",
      keyShort: rec.analysis?.key ? `${rec.analysis.key.tonic}${rec.analysis.key.mode === "minor" ? "m" : ""}` : null,
      bars: null,
    });
  }
  sampleStore = [...hits, ...sampleStore];
  return hits;
}

export async function importLocal(args: { path: string }): Promise<TrackInfo> {
  const basename = args.path.split(/[\\/]/).pop() ?? args.path;
  const title = basename.replace(/\.[^.]+$/, "");
  const id = `local-${hashString(args.path).toString(16).slice(0, 12)}`;
  const manifest = await getManifest();
  const store = await getLibraryStore();
  const track: TrackInfo = {
    id,
    title,
    url: args.path,
    sourcePath: args.path,
    wavPath: manifest.track.wavPath,
    durationSec: manifest.track.durationSec,
    sampleRate: 44100,
    channels: 2,
    codec: basename.split(".").pop() ?? "wav",
    workDir: `mock/${id}`,
    peaks: manifest.track.peaks,
    sourceKind: "local",
  };
  const now = new Date().toISOString();
  store.set(id, {
    entry: {
      id,
      title,
      url: args.path,
      durationSec: track.durationSec,
      fetchedAt: now,
      lastOpenedAt: now,
      kept: false,
      hasLoop: false,
      loopStartSec: null,
      loopEndSec: null,
      hasBands: false,
      hasInstruments: false,
      instrumentCount: 0,
      bytes: estimateBytes(track.durationSec, false, false, false),
    },
    track,
    loop: null,
    stems: null,
    instruments: null,
    analysis: null,
  });
  return track;
}

export async function saveSample(args: { trackId: string; stemKey: string; name?: string; region?: RegionParams }): Promise<Sample> {
  const store = await getLibraryStore();
  const rec = store.get(args.trackId);
  if (!rec) throw new Error(`Unknown track: ${args.trackId}`);
  const source = findSampleSource(rec, args.stemKey);
  if (!source) throw new Error(`Unknown stem: ${args.stemKey}`);

  let startSec = rec.loop?.startSec ?? 0;
  let endSec = rec.loop?.endSec ?? rec.track.durationSec;
  let bars: number | null = null;
  if (args.region) {
    const snapped = snapRegion(args.region.startSec, args.region.endSec, args.region.snap, rec.analysis);
    startSec = snapped.startSec;
    endSec = snapped.endSec;
    bars = snapped.bars;
  }
  const keyShort = rec.analysis?.key ? `${rec.analysis.key.tonic}${rec.analysis.key.mode === "minor" ? "m" : ""}` : null;
  const bpmPart = rec.analysis?.bpm ? ` - ${rec.analysis.bpm}bpm` : "";
  const keyPart = keyShort ? ` - ${keyShort}` : "";
  const barsPart = bars ? ` - ${bars}bars` : "";
  const defaultName = args.region
    ? `${rec.entry.title} - ${source.label}${bpmPart}${keyPart}${barsPart}`
    : `${rec.entry.title} - ${source.label} ${formatMmSs(startSec)}-${formatMmSs(endSec)}`;
  let name = (args.name ?? "").trim() || defaultName;
  let suffix = 2;
  const base = name;
  while (sampleStore.some((s) => s.name === name)) {
    name = `${base} (${suffix})`;
    suffix += 1;
  }

  const sample: Sample = {
    id: `sample_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    path: source.path,
    bytes: 900_000,
    songId: args.trackId,
    songTitle: rec.entry.title,
    stemKey: args.stemKey,
    stemLabel: source.label,
    group: source.group,
    startSec,
    endSec,
    durationSec: endSec - startSec,
    bpm: rec.analysis?.bpm ?? null,
    createdAt: new Date().toISOString(),
    peaks: synthesizePeaks(source.path + "|sample|" + args.trackId + args.stemKey),
    kind: args.region ? "region" : "stem",
    keyShort,
    bars,
  };
  sampleStore = [sample, ...sampleStore];
  return sample;
}

export async function listSamples(): Promise<Sample[]> {
  return [...sampleStore].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function renameSample(args: { id: string; name: string }): Promise<Sample> {
  const sample = sampleStore.find((s) => s.id === args.id);
  if (!sample) throw new Error(`Unknown sample: ${args.id}`);
  sample.name = args.name;
  return sample;
}

export async function deleteSample(args: { id: string }): Promise<void> {
  const sample = sampleStore.find((s) => s.id === args.id);
  if (sample) {
    trashStore = [
      { entry: { id: args.id, kind: "sample", name: sample.name, deletedAt: new Date().toISOString(), bytes: sample.bytes }, restoreSample: sample },
      ...trashStore,
    ];
  }
  sampleStore = sampleStore.filter((s) => s.id !== args.id);
}

export async function exportSamples(args: { ids: string[]; destDir?: string }): Promise<string[]> {
  const destDir = args.destDir ?? "mock/exports";
  return args.ids.map((id) => {
    const sample = sampleStore.find((s) => s.id === id);
    const basename = (sample?.name ?? id).replace(/[\\/:*?"<>|]/g, "_");
    return `${destDir}/${basename}.wav`;
  });
}

export async function revealSample(_args: { id: string }): Promise<void> {
  await delay(30);
}
