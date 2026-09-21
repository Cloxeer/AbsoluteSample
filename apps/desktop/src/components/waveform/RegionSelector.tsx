import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";

export interface RegionSelectorProps {
  wavUrl: string;
  initialStart?: number;
  initialEnd?: number;
  onChange: (start: number, end: number) => void;
  onReady?: (ws: WaveSurfer) => void;
}

export function RegionSelector({ wavUrl, initialStart = 30, initialEnd = 45, onChange, onReady }: RegionSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [snap, setSnap] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#7C5CFF",
      progressColor: "#35D0FF",
      cursorColor: "#35D0FF",
      height: 96,
      url: wavUrl,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
      const region = regions.addRegion({
        start: initialStart,
        end: initialEnd,
        color: "rgba(124,92,255,0.25)",
        drag: true,
        resize: true,
      });
      regionRef.current = region;
      onReady?.(ws);
    });

    regions.on("region-updated", (region: Region) => {
      setStart(Number(region.start.toFixed(3)));
      setEnd(Number(region.end.toFixed(3)));
      onChange(Number(region.start.toFixed(3)), Number(region.end.toFixed(3)));
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavUrl]);

  const applyRange = (s: number, e: number) => {
    const snapped = snap ? Math.round(s * 1000) / 1000 : s;
    const snappedEnd = snap ? Math.round(e * 1000) / 1000 : e;
    setStart(snapped);
    setEnd(snappedEnd);
    regionRef.current?.setOptions({ start: snapped, end: snappedEnd });
    onChange(snapped, snappedEnd);
  };

  const quick15s = () => applyRange(start, start + 15);
  const quick8Bars = (bpm = 120) => applyRange(start, start + (8 * 4 * 60) / bpm);

  return (
    <Surface variant="raised" className="p-4 flex flex-col gap-3">
      <div ref={containerRef} data-testid="region-waveform" />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          Start
          <input
            type="number"
            step={0.001}
            value={start}
            onChange={(e) => applyRange(Number(e.target.value), end)}
            className="w-24 bg-surface neu-surface-inset rounded-lg px-2 py-1 text-text text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          End
          <input
            type="number"
            step={0.001}
            value={end}
            onChange={(e) => applyRange(start, Number(e.target.value))}
            className="w-24 bg-surface neu-surface-inset rounded-lg px-2 py-1 text-text text-sm"
          />
        </label>
        <Button onClick={quick15s}>15s</Button>
        <Button onClick={() => quick8Bars()}>8 bars</Button>
        <Button pressed={snap} onClick={() => setSnap((v) => !v)}>
          Snap
        </Button>
      </div>
    </Surface>
  );
}
