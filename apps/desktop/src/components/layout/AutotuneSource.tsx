import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { UploadCloud } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { isTauri } from "@/lib/mediaUrl";
import type { InstrumentStem, Sample } from "@/lib/types";

const AUDIO_EXTENSIONS = ["wav", "flac", "mp3", "m4a", "aiff", "ogg"];
const VOCAL_KEYS = new Set(["vocals", "lead_vocals", "backing_vocals"]);

export interface SongSourceOption {
  key: string;
  label: string;
  path: string;
  group: string;
  peaks?: number[];
  durationSec?: number;
}

export interface AutotuneSourceValue {
  path: string;
  label: string;
  kind: "own" | "song";
  /** Object URL for a dropped/chosen file when running outside Tauri, so the waveform can render the real audio. */
  fileUrl?: string;
  peaks?: number[];
  durationSec?: number;
}

export interface AutotuneSourceProps {
  instruments: InstrumentStem[] | null | undefined;
  samples: Sample[];
  value: AutotuneSourceValue | null;
  onChange: (value: AutotuneSourceValue) => void;
}

/** Builds the "Or use a vocal from this song" options: vocal-ish stems first, then other stems, then saved samples. */
export function buildSongSourceOptions(instruments: InstrumentStem[] | null | undefined, samples: Sample[]): SongSourceOption[] {
  const options: SongSourceOption[] = [];
  const stems = instruments ?? [];
  const vocal = stems.filter((s) => VOCAL_KEYS.has(s.key));
  const other = stems.filter((s) => !VOCAL_KEYS.has(s.key));
  for (const stem of [...vocal, ...other]) {
    options.push({
      key: stem.key,
      label: stem.displayLabel ?? stem.label,
      path: stem.path,
      group: "Instrument stems",
      peaks: stem.peaks,
      durationSec: stem.durationSec,
    });
  }
  for (const sample of samples) {
    options.push({
      key: sample.id,
      label: sample.name,
      path: sample.path,
      group: "Saved samples",
      peaks: sample.peaks,
      durationSec: sample.durationSec,
    });
  }
  return options;
}

async function pickTauriFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  if (!picked || Array.isArray(picked)) return null;
  return picked;
}

/**
 * Source picker for the Autotune tab: either the user's own dropped/chosen vocal file, or a
 * vocal-ish stem/sample already produced for the currently loaded song. Mirrors the drop-file
 * pattern in components/layout/SourcePicker.tsx but resolves straight to an absolute path (Tauri)
 * or a file name + object URL (browser/mock) instead of importing a whole new track.
 */
export function AutotuneSource({ instruments, samples, value, onChange }: AutotuneSourceProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tauri = isTauri();
  const songOptions = buildSongSourceOptions(instruments, samples);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          setDragOver(false);
          const path = event.payload.paths[0];
          if (path) {
            const label = path.split(/[\\/]/).pop() ?? path;
            onChangeRef.current({ path, label, kind: "own" });
          }
        } else if (event.payload.type === "over") {
          setDragOver(true);
        } else {
          setDragOver(false);
        }
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauri]);

  const chooseOwnFile = async (file: File) => {
    const fileUrl = URL.createObjectURL(file);
    onChange({ path: file.name, label: file.name, kind: "own", fileUrl });
  };

  const handleChooseFile = async () => {
    if (tauri) {
      const path = await pickTauriFile();
      if (path) onChange({ path, label: path.split(/[\\/]/).pop() ?? path, kind: "own" });
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleBrowserFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void chooseOwnFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (tauri) return; // Tauri drops are handled via onDragDropEvent above.
    const file = e.dataTransfer.files?.[0];
    if (file) void chooseOwnFile(file);
  };

  const handleSongPick = (path: string) => {
    if (!path) return;
    const opt = songOptions.find((o) => o.path === path);
    if (!opt) return;
    onChange({ path: opt.path, label: opt.label, kind: "song", peaks: opt.peaks, durationSec: opt.durationSec });
  };

  const grouped = songOptions.reduce<Record<string, SongSourceOption[]>>((acc, s) => {
    (acc[s.group] ??= []).push(s);
    return acc;
  }, {});

  return (
    <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-3">
      <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleBrowserFileChange} />

      <div
        data-testid="autotune-dropzone"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleChooseFile}
        className={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors neu-surface-inset bg-surface",
          dragOver && "ring-2 ring-accent/60"
        )}
      >
        <UploadCloud size={16} className="text-muted shrink-0" />
        <span className="text-xs text-muted">Drop your vocal here</span>
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleChooseFile();
          }}
        >
          Choose file
        </Button>
      </div>

      <span className="text-xs text-muted">or</span>

      <label className="flex items-center gap-2 text-xs text-muted">
        Use a vocal from this song
        <select
          value={value?.kind === "song" ? value.path : ""}
          onChange={(e) => handleSongPick(e.target.value)}
          className="bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-sm text-text min-w-[200px]"
          aria-label="Vocal from this song"
        >
          <option value="" disabled>
            {songOptions.length === 0 ? "No stems or samples yet" : "Choose..."}
          </option>
          {Object.entries(grouped).map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map((opt) => (
                <option key={opt.key + opt.path} value={opt.path}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {value && (
        <span className="flex items-center gap-2 ml-auto text-xs">
          <span className="text-text truncate max-w-[220px]">{value.label}</span>
          <span
            className={clsx(
              "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide",
              value.kind === "own" ? "bg-accent/20 text-accent" : "bg-cyan-500/20 text-cyan-300"
            )}
          >
            {value.kind === "own" ? "Your file" : "From song"}
          </span>
        </span>
      )}
    </Surface>
  );
}
