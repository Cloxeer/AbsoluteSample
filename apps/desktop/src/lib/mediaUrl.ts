import { convertFileSrc } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function mediaUrl(path: string): string {
  if (isTauri()) {
    return convertFileSrc(path);
  }
  return path;
}
