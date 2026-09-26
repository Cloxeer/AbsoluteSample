/**
 * Canvas 2D rendering of the Melodyne-style note editor. Two layers: the main scene (rulers, scale
 * beams, waveform lane, blobs, pitch curves) redrawn on data/viewport changes, and a light overlay
 * (playhead, marquee) redrawn every animation frame during playback.
 */
import {
  firstVoiced,
  formatTime,
  isInScale,
  isNoteEdited,
  lastVoiced,
  midiToY,
  noteName,
  pitchClass,
  pitchReadout,
  formatCents,
  rulerStep,
  timeToX,
  voicedRuns,
  xToTime,
  yToMidi,
  type Analysis,
  type EditorLayout,
  type Rect,
  type Viewport,
} from "./melodyneEditor";

export const COLORS = {
  bg: "#141519",
  beam: "#25272d",
  beamTonic: "#2c2d33",
  offScale: "#17181c",
  rowLine: "rgba(0,0,0,0.38)",
  cLine: "rgba(255,255,255,0.13)",
  timeLine: "rgba(255,255,255,0.045)",
  ruler: "#1c1d22",
  rulerText: "#9A9EA8",
  rulerTextDim: "#5f636c",
  rulerTextIn: "#d9dbe0",
  waveBg: "#17181c",
  wave: "rgba(240,160,75,0.55)",
  blob: "#F0A04B",
  blobTop: "#F6BA72",
  blobEdge: "#A45E1F",
  blobSel: "#D8553A",
  blobSelTop: "#E6775C",
  blobSelEdge: "#86301E",
  curveCore: "rgba(40,22,10,0.92)",
  curveHalo: "rgba(255,236,214,0.35)",
  curveOrig: "rgba(255,255,255,0.3)",
  transition: "rgba(255,255,255,0.32)",
  tick: "rgba(30,16,8,0.85)",
  playhead: "rgba(255,255,255,0.9)",
  marqueeFill: "rgba(240,160,75,0.12)",
  marqueeEdge: "rgba(240,160,75,0.75)",
};

const FONT = "Manrope, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface SceneState {
  layout: EditorLayout;
  vp: Viewport;
  analysis: Analysis;
  profiles: readonly Float32Array[];
  scalePcs: readonly number[];
  tonicPc: number;
  selected: ReadonlySet<number>;
  /** Pitch each dragged note is currently shown at (index -> fractional MIDI). */
  overrides: ReadonlyMap<number, number> | null;
  peaks: Float32Array | null;
  peakBlock: number;
  peakMax: number;
  sampleRate: number;
}

function displayTarget(s: SceneState, i: number): number {
  return s.overrides?.get(i) ?? s.analysis.notes[i].target;
}

export function drawScene(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp } = s;
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // ---- Grid (clipped) ----
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.gridLeft, layout.gridTop, layout.gridWidth, layout.gridHeight);
  ctx.clip();
  drawRows(ctx, s);
  drawTimeLines(ctx, s, layout.gridTop, layout.height);
  drawNotes(ctx, s);
  ctx.restore();

  drawWaveLane(ctx, s);
  drawTimeRuler(ctx, s);
  drawPitchRuler(ctx, s);

  // Corner and lane labels
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, layout.gridLeft, layout.gridTop);
  ctx.fillStyle = COLORS.rulerTextDim;
  ctx.font = `600 9px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText("WAVE", layout.gridLeft / 2, layout.waveTop + layout.waveHeight / 2);
  ctx.fillText("TIME", layout.gridLeft / 2, layout.waveTop / 2);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.gridLeft - 0.5, 0);
  ctx.lineTo(layout.gridLeft - 0.5, layout.height);
  ctx.moveTo(0, layout.gridTop - 0.5);
  ctx.lineTo(layout.width, layout.gridTop - 0.5);
  ctx.stroke();
  ctx.restore();
}

function visibleMidiRange(s: SceneState): [number, number] {
  const top = Math.ceil(s.vp.topMidi + 0.5);
  const bottom = Math.floor(yToMidi(s.layout.gridTop + s.layout.gridHeight, s.vp, s.layout) - 0.5);
  return [bottom, top];
}

function drawRows(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp } = s;
  const [lo, hi] = visibleMidiRange(s);
  for (let m = lo; m <= hi; m++) {
    const y0 = midiToY(m + 0.5, vp, layout);
    const inScale = isInScale(m, s.scalePcs);
    ctx.fillStyle = inScale ? (pitchClass(m) === s.tonicPc ? COLORS.beamTonic : COLORS.beam) : COLORS.offScale;
    ctx.fillRect(layout.gridLeft, y0, layout.gridWidth, vp.rowPx);
    ctx.fillStyle = pitchClass(m) === 0 ? COLORS.cLine : COLORS.rowLine;
    ctx.fillRect(layout.gridLeft, Math.round(y0 + vp.rowPx) - 1, layout.gridWidth, 1);
  }
}

function drawTimeLines(ctx: CanvasRenderingContext2D, s: SceneState, y0: number, y1: number): void {
  const { layout, vp } = s;
  const step = rulerStep(vp.pxPerSec);
  const t0 = Math.floor(vp.scrollSec / step) * step;
  const t1 = xToTime(layout.width, vp, layout);
  ctx.fillStyle = COLORS.timeLine;
  for (let t = t0; t <= t1; t += step) {
    const x = Math.round(timeToX(t, vp, layout));
    if (x < layout.gridLeft) continue;
    ctx.fillRect(x, y0, 1, y1 - y0);
  }
}

function drawNotes(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp, analysis } = s;
  const { notes, hopSec, editedPitch, pitch } = analysis;
  const tMin = xToTime(layout.gridLeft - 4, vp, layout);
  const tMax = xToTime(layout.width + 4, vp, layout);
  const pxPerFrame = hopSec * vp.pxPerSec;
  const stride = Math.max(1, Math.floor(1.5 / Math.max(1e-6, pxPerFrame)));
  const visible: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].endSec >= tMin && notes[i].startSec <= tMax) visible.push(i);
  }

  // Blobs
  for (const i of visible) {
    const n = notes[i];
    const prof = s.profiles[i];
    if (!prof || prof.length === 0) continue;
    const cy = midiToY(displayTarget(s, i), vp, layout);
    const sel = s.selected.has(i);
    const start = Math.floor(n.startFrame);
    const frames: number[] = [];
    for (let k = 0; k < prof.length; k += stride) frames.push(k);
    if (frames[frames.length - 1] !== prof.length - 1) frames.push(prof.length - 1);
    const xAt = (k: number) => timeToX((start + k) * hopSec, vp, layout);
    let maxHalf = 0;
    ctx.beginPath();
    frames.forEach((k, j) => {
      const h = prof[k] * vp.rowPx;
      maxHalf = Math.max(maxHalf, h);
      if (j === 0) ctx.moveTo(xAt(k), cy - h);
      else ctx.lineTo(xAt(k), cy - h);
    });
    for (let j = frames.length - 1; j >= 0; j--) ctx.lineTo(xAt(frames[j]), cy + prof[frames[j]] * vp.rowPx);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, cy - maxHalf, 0, cy + maxHalf);
    grad.addColorStop(0, sel ? COLORS.blobSelTop : COLORS.blobTop);
    grad.addColorStop(0.55, sel ? COLORS.blobSel : COLORS.blob);
    grad.addColorStop(1, sel ? COLORS.blobSel : COLORS.blob);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = sel ? COLORS.blobSelEdge : COLORS.blobEdge;
    ctx.stroke();
  }

  // Original curves (faint) for edited notes
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.curveOrig;
  for (const i of visible) {
    const n = notes[i];
    const dragged = s.overrides?.has(i) ?? false;
    if (!isNoteEdited(n) && !dragged) continue;
    strokeCurve(ctx, s, pitch, n.startFrame, n.endFrame, 0, stride);
  }
  ctx.setLineDash([]);

  // Transition lines between consecutive notes
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.transition;
  ctx.beginPath();
  for (let v = 0; v < visible.length; v++) {
    const i = visible[v];
    const a = notes[i];
    const b = notes[i + 1];
    if (!b || b.startSec - a.endSec > 0.3) continue;
    const fa = lastVoiced(editedPitch, a.startFrame, a.endFrame);
    const fb = firstVoiced(editedPitch, b.startFrame, b.endFrame);
    if (fa === null || fb === null) continue;
    const ya = midiToY((editedPitch[fa] as number) + shiftOf(s, i), vp, layout);
    const yb = midiToY((editedPitch[fb] as number) + shiftOf(s, i + 1), vp, layout);
    ctx.moveTo(timeToX(fa * hopSec, vp, layout), ya);
    ctx.lineTo(timeToX(fb * hopSec, vp, layout), yb);
  }
  ctx.stroke();

  // Edited pitch curves: light halo + dark core so they read on both the blob and the background.
  for (const pass of [0, 1]) {
    ctx.lineWidth = pass === 0 ? 3 : 1.3;
    ctx.strokeStyle = pass === 0 ? COLORS.curveHalo : COLORS.curveCore;
    ctx.lineJoin = "round";
    for (const i of visible) {
      const n = notes[i];
      strokeCurve(ctx, s, editedPitch, n.startFrame, n.endFrame, shiftOf(s, i), stride);
    }
  }

  // Soft-separation ticks between touching notes
  ctx.strokeStyle = COLORS.tick;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const i of visible) {
    const a = notes[i];
    const b = notes[i + 1];
    if (!b || b.startFrame - a.endFrame > 1) continue;
    const x = Math.round(timeToX(b.startSec, vp, layout)) + 0.5;
    for (const j of [i, i + 1]) {
      const cy = midiToY(displayTarget(s, j), vp, layout);
      ctx.moveTo(x, cy - vp.rowPx * 0.32);
      ctx.lineTo(x, cy + vp.rowPx * 0.32);
    }
  }
  ctx.stroke();

  // Pitch label pill on dragged notes (or a single selected note)
  const labelled = s.overrides && s.overrides.size > 0 ? [...s.overrides.keys()] : s.selected.size === 1 ? [...s.selected] : [];
  for (const i of labelled) {
    const n = notes[i];
    if (!n || n.endSec < tMin || n.startSec > tMax) continue;
    const p = displayTarget(s, i);
    const { name, cents } = pitchReadout(p);
    const text = cents === 0 ? name : `${name} ${formatCents(cents)}`;
    ctx.font = `700 11px ${FONT}`;
    const w = ctx.measureText(text).width + 12;
    const x = Math.max(layout.gridLeft + 2, timeToX(n.startSec, vp, layout));
    const cy = midiToY(p, vp, layout);
    const y = cy - vp.rowPx * 0.5 - 20;
    ctx.fillStyle = "rgba(15,16,19,0.88)";
    roundRect(ctx, x, y, w, 17, 8);
    ctx.fill();
    ctx.strokeStyle = s.selected.has(i) ? COLORS.blobSel : COLORS.blob;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + 9);
  }
}

function shiftOf(s: SceneState, i: number): number {
  const o = s.overrides?.get(i);
  return o === undefined ? 0 : o - s.analysis.notes[i].target;
}

function strokeCurve(
  ctx: CanvasRenderingContext2D,
  s: SceneState,
  values: readonly (number | null)[],
  startFrame: number,
  endFrame: number,
  shift: number,
  stride: number
): void {
  const { vp, layout, analysis } = s;
  ctx.beginPath();
  for (const [a, b] of voicedRuns(values, startFrame, endFrame)) {
    let first = true;
    for (let f = a; f <= b; f += stride) {
      const x = timeToX(f * analysis.hopSec, vp, layout);
      const y = midiToY((values[f] as number) + shift, vp, layout);
      if (first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      first = false;
    }
    if ((b - a) % stride !== 0) ctx.lineTo(timeToX(b * analysis.hopSec, vp, layout), midiToY((values[b] as number) + shift, vp, layout));
  }
  ctx.stroke();
}

function drawWaveLane(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp } = s;
  const top = layout.waveTop;
  const h = layout.waveHeight;
  ctx.fillStyle = COLORS.waveBg;
  ctx.fillRect(layout.gridLeft, top, layout.gridWidth, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.gridLeft, top, layout.gridWidth, h);
  ctx.clip();
  drawTimeLines(ctx, s, top, top + h);
  const mid = top + h / 2;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(layout.gridLeft, Math.round(mid), layout.gridWidth, 1);
  const peaks = s.peaks;
  if (peaks && peaks.length > 0 && s.peakMax > 0) {
    ctx.fillStyle = COLORS.wave;
    const samplesPerPx = s.sampleRate / vp.pxPerSec;
    const scale = (h / 2 - 3) / s.peakMax;
    for (let x = layout.gridLeft; x < layout.width; x++) {
      const t0 = xToTime(x, vp, layout);
      if (t0 < 0) continue;
      const b0 = Math.floor((t0 * s.sampleRate) / s.peakBlock);
      const b1 = Math.max(b0 + 1, Math.floor(((t0 * s.sampleRate + samplesPerPx) / s.peakBlock)));
      if (b0 >= peaks.length) break;
      let m = 0;
      for (let b = b0; b < Math.min(b1, peaks.length); b++) if (peaks[b] > m) m = peaks[b];
      const a = Math.max(0.5, m * scale);
      ctx.fillRect(x, mid - a, 1, a * 2);
    }
  }
  ctx.restore();
}

function drawTimeRuler(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp } = s;
  const h = layout.waveTop;
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(layout.gridLeft, 0, layout.gridWidth, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.gridLeft, 0, layout.gridWidth, h);
  ctx.clip();
  const step = rulerStep(vp.pxPerSec);
  const t0 = Math.floor(vp.scrollSec / step) * step;
  const t1 = xToTime(layout.width, vp, layout);
  ctx.font = `600 10px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let t = t0; t <= t1 + step; t += step) {
    const x = Math.round(timeToX(t, vp, layout));
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(x, h - 8, 1, 8);
    const half = Math.round(timeToX(t + step / 2, vp, layout));
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(half, h - 4, 1, 4);
    ctx.fillStyle = COLORS.rulerText;
    ctx.fillText(formatTime(t, step), x + 4, h / 2 - 1);
  }
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(layout.gridLeft, h - 1, layout.gridWidth, 1);
}

function drawPitchRuler(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { layout, vp } = s;
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, layout.gridTop, layout.gridLeft, layout.gridHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, layout.gridTop, layout.gridLeft, layout.gridHeight);
  ctx.clip();
  const [lo, hi] = visibleMidiRange(s);
  const showAll = vp.rowPx >= 11;
  const fontPx = Math.max(8, Math.min(11, vp.rowPx - 2));
  for (let m = lo; m <= hi; m++) {
    const y0 = midiToY(m + 0.5, vp, layout);
    const inScale = isInScale(m, s.scalePcs);
    const isC = pitchClass(m) === 0;
    if (inScale) {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, y0, layout.gridLeft, vp.rowPx);
    }
    ctx.fillStyle = isC ? COLORS.cLine : "rgba(0,0,0,0.3)";
    ctx.fillRect(isC ? 0 : layout.gridLeft * 0.45, Math.round(y0 + vp.rowPx) - 1, isC ? layout.gridLeft : layout.gridLeft * 0.55, 1);
    if (!showAll && !isC) continue;
    ctx.font = `${isC ? 800 : 600} ${fontPx}px ${FONT}`;
    ctx.fillStyle = isC ? "#ffffff" : inScale ? COLORS.rulerTextIn : COLORS.rulerTextDim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(noteName(m), layout.gridLeft - 8, y0 + vp.rowPx / 2);
  }
  ctx.restore();
}

export interface OverlayState {
  layout: EditorLayout;
  vp: Viewport;
  playheadSec: number;
  marquee: Rect | null;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayState): void {
  const { layout, vp } = o;
  ctx.clearRect(0, 0, layout.width, layout.height);
  const x = Math.round(timeToX(o.playheadSec, vp, layout)) + 0.5;
  if (x >= layout.gridLeft && x <= layout.width) {
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x - 0.5, layout.waveTop, 1, layout.height - layout.waveTop);
    // Marker in the time ruler
    ctx.beginPath();
    ctx.moveTo(x - 5, layout.waveTop - 9);
    ctx.lineTo(x + 5, layout.waveTop - 9);
    ctx.lineTo(x, layout.waveTop - 1);
    ctx.closePath();
    ctx.fill();
  }
  if (o.marquee) {
    const { x0, y0, x1, y1 } = o.marquee;
    ctx.fillStyle = COLORS.marqueeFill;
    ctx.strokeStyle = COLORS.marqueeEdge;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    const rx = Math.min(x0, x1);
    const ry = Math.min(y0, y1);
    ctx.fillRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
