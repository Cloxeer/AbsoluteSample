import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { UploadCloud } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { isTauri } from "@/lib/mediaUrl";

const AUDIO_EXTENSIONS = ["wav", "flac", "mp3", "m4a", "aiff", "ogg"];

export interface SourcePickerProps {
  /** Imports a local file by path (Tauri) or by name (browser, mock synthesizes a track from it). */
  onImportLocal: (path: string) => void | Promise<void>;
  url: string;
  onUrlChange: (v: string) => void;
  onFetch: () => void;
  busy: boolean;
  /** Compact layout for the "New link" bar once a song is loaded. */
  compact?: boolean;
}

async function pickTauriFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  if (!picked || Array.isArray(picked)) return null;
  return picked;
}

export function SourcePicker({ onImportLocal, url, onUrlChange, onFetch, busy, compact = false }: SourcePickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tauri = isTauri();
  const onImportLocalRef = useRef(onImportLocal);
  onImportLocalRef.current = onImportLocal;

  // Tauri's native drag/drop bypasses HTML5 DOM drag events, so listen via the webview API instead.
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
          if (path) void onImportLocalRef.current(path);
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

  const handleChooseFile = async () => {
    if (tauri) {
      const path = await pickTauriFile();
      if (path) await onImportLocal(path);
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleBrowserFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void onImportLocal(file.name);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (tauri) return; // Tauri drops are handled via onDragDropEvent below.
    const file = e.dataTransfer.files?.[0];
    if (file) void onImportLocal(file.name);
  };

  return (
    <div className={clsx("flex flex-col gap-3 w-full", compact ? "max-w-2xl mx-auto" : "max-w-2xl mx-auto")}>
      <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleBrowserFileChange} />

      {compact ? (
        <Surface
          variant="inset"
          data-testid="source-picker-dropzone"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={clsx(
            "flex items-center gap-3 px-4 py-2.5 rounded-xl cursor-pointer transition-colors",
            dragOver && "ring-2 ring-accent/60"
          )}
          onClick={handleChooseFile}
        >
          <UploadCloud size={16} className="text-muted shrink-0" />
          <span className="text-xs text-muted flex-1">Drop a file or choose</span>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleChooseFile();
            }}
          >
            Choose file
          </Button>
        </Surface>
      ) : (
        <Surface
          variant="raised"
          data-testid="source-picker-dropzone"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={clsx(
            "flex flex-col items-center gap-4 p-10 rounded-2xl text-center transition-colors cursor-pointer",
            dragOver && "ring-2 ring-accent/60"
          )}
          onClick={handleChooseFile}
        >
          <UploadCloud size={40} className="text-muted" />
          <p className="text-lg font-medium">Drop a WAV, FLAC or MP3 here</p>
          <p className="text-xs text-muted">Also supports M4A, AIFF and OGG</p>
          <Button
            type="button"
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              void handleChooseFile();
            }}
          >
            Choose file
          </Button>
        </Surface>
      )}

      <div className="flex flex-col gap-2 items-stretch">
        <label htmlFor="youtube-url" className="text-xs text-muted uppercase tracking-wide">
          or paste a YouTube link
        </label>
        <div className="flex gap-2">
          <input
            id="youtube-url"
            type="text"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://youtube.com/watch?v=..."
            className="flex-1 bg-surface neu-surface-inset rounded-xl px-4 py-2 text-text text-sm outline-none"
          />
          <Button variant={compact ? "default" : "primary"} busy={busy} busyLabel="Fetching" onClick={onFetch} disabled={!url}>
            Fetch
          </Button>
        </div>
      </div>
    </div>
  );
}
