import { backend } from "./backend";
import type { InstrumentStem } from "./types";

/**
 * v11 helpers for stems that may be derived (a recipe with path "") or stored as FLAC/WAV with
 * versioned names after Enhance. Every consumer that needs a real file goes through here.
 */

const VIRTUAL_PREFIX = "stem:";

export function isDerived(stem: Pick<InstrumentStem, "path" | "derived">): boolean {
  return !!stem.derived || !stem.path;
}

/**
 * A stable, unique source identifier for pickers (Notes/Frequencies/Autotune): the real path for a
 * stored stem, or a virtual "stem:<trackId>:<key>" for a derived one (resolve it with realPath()).
 */
export function stemSourcePath(stem: Pick<InstrumentStem, "key" | "path" | "derived">, trackId: string | null | undefined): string {
  if (!isDerived(stem)) return stem.path;
  return `${VIRTUAL_PREFIX}${trackId ?? ""}:${stem.key}`;
}

export function isVirtualPath(path: string): boolean {
  return path.startsWith(VIRTUAL_PREFIX);
}

/** Turns a picker path into a real file path, materializing a derived stem via backend.stemFile(). */
export async function realPath(path: string): Promise<string> {
  if (!isVirtualPath(path)) return path;
  const rest = path.slice(VIRTUAL_PREFIX.length);
  const sep = rest.indexOf(":"); // track ids never contain ":"; keys may ("karaoke:<key>")
  const trackId = rest.slice(0, sep);
  const key = rest.slice(sep + 1);
  return backend.stemFile({ trackId, key });
}

/** A real file for this stem: its stored path, or a materialized file for a derived stem. */
export async function stemRealPath(trackId: string, stem: Pick<InstrumentStem, "key" | "path" | "derived">, keyPrefix = ""): Promise<string> {
  if (!isDerived(stem)) return stem.path;
  return backend.stemFile({ trackId, key: `${keyPrefix}${stem.key}` });
}

/** "wav" / "flac" (lower case) from a file path; defaults to "wav". */
export function audioExtension(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path.split(/[\\/]/).pop() ?? "");
  const ext = m ? m[1].toLowerCase() : "wav";
  return ext === "flac" || ext === "wav" ? ext : "wav";
}

/**
 * Download file name that keeps the stem key (versioned names like "vocals.3.flac" become
 * "vocals.flac"; derived stems materialized as "_derived/other.wav" become "other.wav").
 */
export function downloadName(stemKey: string, realFilePath: string): string {
  return `${stemKey}.${audioExtension(realFilePath)}`;
}
