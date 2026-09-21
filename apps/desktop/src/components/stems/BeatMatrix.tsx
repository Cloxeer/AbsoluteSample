import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import { onsetsFromAnalysis, padsForRow } from "@/lib/beatMatrix";
import type { InstrumentStem, LoopAnalysis, Sample } from "@/lib/types";
import { groupInstruments } from "@/lib/instruments";
import { isAudible } from "@/lib/stemPresence";

const INSTRUMENT_COLORS: Record<string, string> = {
  vocals: "#F25F5C",
  drums: "#F2B33D",
  bass: "#4C8BF5",
  guitar: "#3DD68C",
  keys: "#B692F6",
  other: "#8A94A6",
};

interface Row {
  key: string;
  label: string;
  color: string;
  path: string;
  kind: "instrument" | "sample";
}

export interface BeatMatrixProps {
  analysis: LoopAnalysis;
  instruments: InstrumentStem[] | null;
  samples: Sample[];
  currentTime: number;
  isPlaying: boolean;
}

/**
 * Rows = current song's top-level instrument stems (kit children when expanded) plus saved samples
 * the user adds. Each row's pads come from that row's own onset analysis. The only transport is the
 * top Transport bar (Play/Pause); a column highlight follows currentTime.
 */
export function BeatMatrix({ analysis, instruments, samples, currentTime, isPlaying }: BeatMatrixProps) {
  const [subdivision, setSubdivision] = useState<"beats" | "16ths">("16ths");
  const [expandedKit, setExpandedKit] = useState(false);
  const [sampleRowIds, setSampleRowIds] = useState<string[]>([]);
  const [rowAnalyses, setRowAnalyses] = useState<Record<string, LoopAnalysis>>({});
  const [activePad, setActivePad] = useState<string | null>(null);

  const nodes = useMemo(() => (instruments ? groupInstruments(instruments) : []), [instruments]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const node of nodes) {
      if (!isAudible(node.stem)) continue;
      out.push({ key: node.stem.key, label: node.stem.label, color: INSTRUMENT_COLORS[node.stem.group] ?? "#8A94A6", path: node.stem.path, kind: "instrument" });
      if (expandedKit && node.children.length > 0) {
        for (const child of node.children) {
          if (!isAudible(child)) continue;
          out.push({ key: child.key, label: `  ${child.label}`, color: INSTRUMENT_COLORS[child.group] ?? "#8A94A6", path: child.path, kind: "instrument" });
        }
      }
    }
    for (const id of sampleRowIds) {
      const s = samples.find((sm) => sm.id === id);
      if (s) out.push({ key: `sample:${s.id}`, label: s.name, color: "#4CC9F0", path: s.path, kind: "sample" });
    }
    return out;
  }, [nodes, expandedKit, sampleRowIds, samples]);

  // Each row runs analyzeFile once per path, cached in component state.
  useEffect(() => {
    let cancelled = false;
    for (const row of rows) {
      if (rowAnalyses[row.path]) continue;
      backend.analyzeFile({ path: row.path }).then((result) => {
        if (cancelled) return;
        setRowAnalyses((prev) => (prev[row.path] ? prev : { ...prev, [row.path]: result }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const bars = Math.max(1, analysis.bars);
  const step = analysis.beatGrid.length > 1 ? analysis.beatGrid[1] - analysis.beatGrid[0] : 60 / analysis.bpm;
  const subdivStep = subdivision === "16ths" ? step / 4 : step;
  const totalCols = subdivision === "16ths" ? bars * 16 : bars * 4;
  const grid = useMemo(() => Array.from({ length: totalCols }, (_, i) => i * subdivStep), [totalCols, subdivStep]);
  const windowSec = subdivStep / 2;

  const activeCol = useMemo(() => {
    if (!isPlaying) return -1;
    return Math.floor(currentTime / subdivStep) % Math.max(1, totalCols);
  }, [currentTime, isPlaying, subdivStep, totalCols]);

  const handlePadClick = async (row: Row, colIndex: number) => {
    const padId = `${row.key}-${colIndex}`;
    if (samplePlayer.isPlaying(padId)) {
      samplePlayer.stop();
      setActivePad(null);
      return;
    }
    const url = await backend.resolveWavUrl(row.path);
    const start = grid[colIndex];
    samplePlayer.playPath(padId, url, { start, end: start + subdivStep });
    setActivePad(padId);
  };

  useEffect(() => {
    const unsub = samplePlayer.subscribe((state) => {
      if (!state.id) setActivePad(null);
    });
    return unsub;
  }, []);

  const availableSamples = samples.filter((s) => !sampleRowIds.includes(s.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Beat Matrix</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={subdivision === "16ths"} onChange={(e) => setSubdivision(e.target.checked ? "16ths" : "beats")} />
            16ths
          </label>
          {nodes.some((n) => n.children && n.children.length > 0) && (
            <button type="button" className="text-xs text-accent underline" onClick={() => setExpandedKit((v) => !v)}>
              {expandedKit ? "Hide kit parts" : "Show kit parts"}
            </button>
          )}
          {availableSamples.length > 0 && (
            <select
              aria-label="Add sample row"
              className="text-xs bg-surface neu-surface-inset rounded-lg px-2 py-1"
              value=""
              onChange={(e) => {
                if (e.target.value) setSampleRowIds((prev) => [...prev, e.target.value]);
                e.target.value = "";
              }}
            >
              <option value="">Add sample row...</option>
              {availableSamples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1 min-w-max overflow-x-auto">
        {rows.map((row) => {
          const rowAnalysis = rowAnalyses[row.path];
          const onsets = rowAnalysis ? onsetsFromAnalysis(rowAnalysis) : [];
          const pads = padsForRow(onsets, grid, windowSec);
          return (
            <div key={row.key} role="group" aria-label={`${row.label} row`} className="flex items-center gap-2 rounded-xl p-1">
              <span className="w-28 text-xs text-muted shrink-0 truncate">{row.label}</span>
              {row.kind === "sample" && (
                <button
                  type="button"
                  aria-label={`Remove ${row.label} row`}
                  className="text-[10px] text-muted hover:text-danger shrink-0"
                  onClick={() => setSampleRowIds((prev) => prev.filter((id) => id !== row.key.slice("sample:".length)))}
                >
                  x
                </button>
              )}
              <div className="flex gap-1">
                {grid.map((_, i) => {
                  const padId = `${row.key}-${i}`;
                  const opacity = pads[i] ?? 0;
                  const lit = opacity > 0.05;
                  const isActiveCol = i === activeCol;
                  const isAuditioning = activePad === padId;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handlePadClick(row, i)}
                      aria-label={`${row.label} pad ${i + 1}`}
                      data-pressed={isAuditioning || undefined}
                      className={clsx(
                        "w-5 h-5 rounded-md transition-[box-shadow,transform] duration-100 active:scale-90",
                        isAuditioning ? "neu-surface-pressed" : "neu-surface-raised bg-surface",
                        isActiveCol && "ring-1 ring-accent"
                      )}
                      style={lit ? { backgroundColor: row.color, opacity: 0.35 + opacity * 0.65 } : undefined}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
