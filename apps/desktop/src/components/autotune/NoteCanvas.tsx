import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  blobProfile,
  clampScroll,
  clampTopMidi,
  computeLayout,
  fitViewport,
  followPlayhead,
  hitTestNotes,
  notesInRect,
  referenceDb,
  regionAt,
  snapPitch,
  xToTime,
  zoomHorizontal,
  edgeScrollPx,
  OPEN_WINDOW_SEC,
  type Analysis,
  type Rect,
  type SnapMode,
  type Viewport,
} from "@/lib/melodyneEditor";
import { drawOverlay, drawScene, type GhostTrack } from "@/lib/melodyneDraw";

/** What the canvas needs from the player: the shared playhead. */
export interface PlayheadSource {
  currentTime(): number;
  subscribe(cb: () => void): () => void;
}

const profileCache = new WeakMap<Analysis, Float32Array[]>();
/** Blob outlines of every note (cached per analysis object, so ghosts are not recomputed on redraws). */
export function profilesFor(analysis: Analysis): Float32Array[] {
  let p = profileCache.get(analysis);
  if (!p) {
    const ref = referenceDb(analysis.db);
    p = analysis.notes.map((n) => blobProfile(n, analysis.db, ref));
    profileCache.set(analysis, p);
  }
  return p;
}

/** Shifts a viewport so a track's local times land on the shared timeline. */
function localVp(vp: Viewport, offsetSec: number): Viewport {
  return offsetSec === 0 ? vp : { ...vp, scrollSec: vp.scrollSec - offsetSec };
}

/** Width used when the container can't be measured (tests / first paint). */
export const FALLBACK_WIDTH = 900;
/** Vertical pixels the pointer must travel before a note drag starts (axis lock). */
export const DRAG_THRESHOLD_PX = 3;

export interface NoteCanvasHandle {
  fit(): void;
  zoom(factor: number): void;
}

export interface NoteCanvasProps {
  analysis: Analysis;
  /** Changes whenever a different audio file is loaded, so the view re-fits. */
  sessionKey: string;
  overrides: ReadonlyMap<number, number> | null;
  selected: ReadonlySet<number>;
  scalePcs: readonly number[];
  tonicPc: number;
  snap: SnapMode;
  peaks: Float32Array | null;
  peaksVersion: number;
  peakBlock: number;
  peakMax: number;
  sampleRate: number;
  player: PlayheadSource;
  playing: boolean;
  /** Where this (the edited) track starts on the shared timeline. Notes are drawn/hit-tested shifted by it. */
  timeOffsetSec?: number;
  /** Length of the shared timeline (defaults to this track's end). */
  timelineDurationSec?: number;
  /** Other tracks drawn as faint outlines. */
  ghosts?: readonly GhostTrack[];
  /** Blob color of the edited track. */
  color?: string;
  /** Id of the edited track (exposed as a data attribute). */
  trackId?: string;
  onSelect(next: Set<number>): void;
  onSeek(sec: number): void;
  onDragStart(indices: number[]): void;
  /** Called whenever the snapped pitch of any dragged note changes. */
  onDragUpdate(targets: Map<number, number>, primary: number): void;
  /** `targets` is null when the pointer was released without moving a note. */
  onDragEnd(targets: Map<number, number> | null): void;
  onSnapNote(index: number): void;
  onSplit(index: number, sec: number): void;
}

type Gesture =
  | {
      kind: "note";
      pointerId: number;
      startY: number;
      primary: number;
      startTargets: Map<number, number>;
      moved: boolean;
      last: Map<number, number> | null;
    }
  | { kind: "marquee"; pointerId: number; rect: Rect; base: Set<number>; additive: boolean }
  | { kind: "seek"; pointerId: number };

/**
 * Melodyne-style note editor surface: a Canvas 2D scene plus an overlay canvas for the playhead and
 * marquee. All hit-testing is done in JS against the same geometry the scene is drawn with.
 */
export const NoteCanvas = forwardRef<NoteCanvasHandle, NoteCanvasProps>(function NoteCanvas(props, ref) {
  const {
    analysis,
    sessionKey,
    overrides,
    selected,
    scalePcs,
    tonicPc,
    snap,
    peaks,
    peaksVersion,
    peakBlock,
    peakMax,
    sampleRate,
    player,
    playing,
    timeOffsetSec = 0,
    ghosts,
    color,
    trackId,
  } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const layout = useMemo(() => computeLayout(width), [width]);
  const [vp, setVp] = useState<Viewport>(() => fitFor(props, computeLayout(FALLBACK_WIDTH), OPEN_WINDOW_SEC));
  const gestureRef = useRef<Gesture | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const vpRef = useRef(vp);
  vpRef.current = vp;

  const profiles = useMemo(() => profilesFor(analysis), [analysis]);
  const offRef = useRef(timeOffsetSec);
  offRef.current = timeOffsetSec;
  const durOf = () => timelineDuration(propsRef.current);

  // Measure container width.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    setVp(fitFor(propsRef.current, layout));
  }, [layout]);

  // Open on a readable window when a new file is loaded or the width changes. Switching to another
  // track (new sessionKey) keeps the time axis where it is and only re-centres the pitch rows.
  const lastSessionRef = useRef<string | null>(null);
  const lastLayoutRef = useRef(layout);
  useEffect(() => {
    const switched = lastSessionRef.current !== null && lastSessionRef.current !== sessionKey && lastLayoutRef.current === layout;
    lastSessionRef.current = sessionKey;
    lastLayoutRef.current = layout;
    const next = fitFor(propsRef.current, layout, OPEN_WINDOW_SEC);
    if (switched) setVp((v) => clampScroll({ ...v, topMidi: next.topMidi, rowPx: next.rowPx }, durOf(), layout));
    else setVp(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, layout]);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoom(factor: number) {
        setVp((v) => zoomHorizontal(v, factor, layout.gridLeft + layout.gridWidth / 2, durOf(), layout));
      },
    }),
    [fit, layout]
  );

  // ---- Drawing ----
  const setupCanvas = (c: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
    if (!c) return null;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext("2d");
    } catch {
      return null;
    }
    if (!ctx) return null;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const w = Math.round(layout.width * dpr);
    const h = Math.round(layout.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };

  useEffect(() => {
    const ctx = setupCanvas(sceneRef.current);
    if (!ctx) return;
    drawScene(ctx, {
      layout,
      vp,
      analysis,
      profiles,
      scalePcs,
      tonicPc,
      selected,
      overrides,
      peaks,
      peakBlock,
      peakMax,
      sampleRate,
      timeOffsetSec,
      color,
      ghosts,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, vp, analysis, profiles, scalePcs, tonicPc, selected, overrides, peaks, peaksVersion, peakBlock, peakMax, sampleRate, timeOffsetSec, color, ghosts]);

  const drawOverlayNow = useCallback(() => {
    const ctx = setupCanvas(overlayRef.current);
    if (!ctx) return;
    drawOverlay(ctx, { layout, vp: vpRef.current, playheadSec: player.currentTime(), marquee });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, vp, marquee, player]);

  useEffect(() => {
    drawOverlayNow();
    return player.subscribe(drawOverlayNow);
  }, [drawOverlayNow, player]);

  // Playback: redraw the playhead every frame and follow it (unless a note is being dragged).
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    const tick = () => {
      const g = gestureRef.current;
      if (!g || g.kind !== "note") {
        const next = followPlayhead(vpRef.current, player.currentTime(), durOf(), layout);
        if (next !== vpRef.current) setVp(next);
      }
      drawOverlayNow();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, player, layout, drawOverlayNow]);

  // ---- Wheel: Ctrl = zoom, Shift = horizontal scroll, plain = vertical scroll ----
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dur = durOf();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0022);
        setVp((v) => zoomHorizontal(v, factor, Math.max(layout.gridLeft, x), dur, layout));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
        setVp((v) => clampScroll({ ...v, scrollSec: v.scrollSec + d / v.pxPerSec }, dur, layout));
      } else {
        setVp((v) => ({ ...v, topMidi: clampTopMidi(v.topMidi - e.deltaY / v.rowPx / 3, v.rowPx, layout) }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [layout]);

  // ---- Pointer interaction ----
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const hitAt = (x: number, y: number) => {
    const p = propsRef.current;
    return hitTestNotes(x, y, p.analysis.notes, profiles, p.analysis.hopSec, localVp(vpRef.current, offRef.current), layout, (i) => p.overrides?.get(i) ?? p.analysis.notes[i].target);
  };

  const seekTo = (x: number) => {
    const sec = Math.max(0, Math.min(durOf(), xToTime(x, vpRef.current, layout)));
    propsRef.current.onSeek(sec);
  };

  // ---- Edge auto-scroll while dragging the playhead ----
  const lastPointerX = useRef(0);
  const edgeRaf = useRef(0);
  const startEdgeScroll = () => {
    if (edgeRaf.current || typeof requestAnimationFrame === "undefined") return;
    const tick = () => {
      const g = gestureRef.current;
      if (!g || g.kind !== "seek") {
        edgeRaf.current = 0;
        return;
      }
      const px = edgeScrollPx(lastPointerX.current, layout);
      if (px !== 0) {
        const dur = durOf();
        const next = clampScroll({ ...vpRef.current, scrollSec: vpRef.current.scrollSec + px / vpRef.current.pxPerSec }, dur, layout);
        vpRef.current = next;
        setVp(next);
        seekTo(Math.max(layout.gridLeft, Math.min(layout.gridLeft + layout.gridWidth, lastPointerX.current)));
      }
      edgeRaf.current = requestAnimationFrame(tick);
    };
    edgeRaf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => {
    if (edgeRaf.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(edgeRaf.current);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const region = regionAt(x, y, layout);
    const p = propsRef.current;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / synthetic pointers */
    }
    if (region === "time-ruler" || region === "wave") {
      if (x >= layout.gridLeft) seekTo(x);
      gestureRef.current = { kind: "seek", pointerId: e.pointerId };
      lastPointerX.current = x;
      startEdgeScroll();
      return;
    }
    if (region !== "grid") return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const hit = hitAt(x, y);
    if (hit) {
      let sel = new Set(p.selected);
      if (additive) {
        if (sel.has(hit.index)) sel.delete(hit.index);
        else sel.add(hit.index);
      } else if (!sel.has(hit.index)) {
        sel = new Set([hit.index]);
      }
      if (!sel.has(hit.index)) {
        // Shift-click toggled the note off: selection change only, no drag.
        p.onSelect(sel);
        gestureRef.current = null;
        return;
      }
      p.onSelect(sel);
      const startTargets = new Map<number, number>();
      for (const i of sel) {
        const n = p.analysis.notes[i];
        if (n) startTargets.set(i, n.target);
      }
      gestureRef.current = { kind: "note", pointerId: e.pointerId, startY: y, primary: hit.index, startTargets, moved: false, last: null };
      return;
    }
    const base = additive ? new Set(p.selected) : new Set<number>();
    if (!additive && p.selected.size > 0) p.onSelect(new Set());
    const rect = { x0: x, y0: y, x1: x, y1: y };
    gestureRef.current = { kind: "marquee", pointerId: e.pointerId, rect, base, additive };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    const g = gestureRef.current;
    const p = propsRef.current;
    if (!g) {
      // Hover cursor feedback
      const c = overlayRef.current;
      if (!c) return;
      const region = regionAt(x, y, layout);
      if (region === "time-ruler") c.style.cursor = "pointer";
      else if (region === "grid") {
        const hit = hitAt(x, y);
        c.style.cursor = hit ? (hit.zone === "top" ? "col-resize" : "grab") : "default";
      } else c.style.cursor = "default";
      return;
    }
    if (g.kind === "seek") {
      lastPointerX.current = x;
      seekTo(x);
      return;
    }
    if (g.kind === "marquee") {
      g.rect = { ...g.rect, x1: x, y1: y };
      setMarquee({ ...g.rect });
      const inside = notesInRect(g.rect, p.analysis.notes, localVp(vpRef.current, offRef.current), layout);
      const next = new Set(g.base);
      inside.forEach((i) => next.add(i));
      p.onSelect(next);
      return;
    }
    // Note drag: vertical axis only; begins after a small threshold.
    const dy = g.startY - y;
    if (!g.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      if (overlayRef.current) overlayRef.current.style.cursor = "grabbing";
      p.onDragStart([...g.startTargets.keys()]);
    }
    const raw = dy / vpRef.current.rowPx;
    const free = e.altKey;
    const next = new Map<number, number>();
    for (const [i, start] of g.startTargets) next.set(i, snapPitch(start + raw, p.snap, p.scalePcs, free));
    const changed = !g.last || [...next].some(([i, t]) => Math.abs((g.last?.get(i) ?? NaN) - t) > 1e-9);
    if (!changed) return;
    g.last = next;
    p.onDragUpdate(next, g.primary);
  };

  const endGesture = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.kind === "marquee") setMarquee(null);
    if (g.kind === "note") {
      if (overlayRef.current) overlayRef.current.style.cursor = "grab";
      propsRef.current.onDragEnd(g.moved && g.last ? g.last : null);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    const hit = hitAt(x, y);
    if (!hit) return;
    if (hit.zone === "top") propsRef.current.onSplit(hit.index, xToTime(x, localVp(vpRef.current, offRef.current), layout));
    else propsRef.current.onSnapNote(hit.index);
  };

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height: layout.height }}>
      <canvas
        ref={sceneRef}
        data-testid="autotune-scene"
        className="absolute inset-0 rounded-xl"
        style={{ width: layout.width, height: layout.height }}
      />
      <canvas
        ref={overlayRef}
        data-testid="autotune-editor"
        data-scroll-sec={vp.scrollSec}
        data-track={trackId}
        data-time-offset={timeOffsetSec}
        data-ghosts={(ghosts ?? []).map((g) => g.id).join(",")}
        className="absolute inset-0 rounded-xl touch-none"
        style={{ width: layout.width, height: layout.height }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
});

function timelineDuration(p: Pick<NoteCanvasProps, "analysis" | "timeOffsetSec" | "timelineDurationSec">): number {
  return Math.max(p.timelineDurationSec ?? 0, p.analysis.durationSec + (p.timeOffsetSec ?? 0));
}

/** Fit on the edited track's notes, placed on the shared timeline. */
function fitFor(
  p: Pick<NoteCanvasProps, "analysis" | "timeOffsetSec" | "timelineDurationSec">,
  layout: ReturnType<typeof computeLayout>,
  windowSec?: number
): Viewport {
  const off = p.timeOffsetSec ?? 0;
  const notes = off === 0 ? p.analysis.notes : p.analysis.notes.map((n) => ({ ...n, startSec: n.startSec + off, endSec: n.endSec + off }));
  return fitViewport(notes, timelineDuration(p), layout, windowSec);
}
