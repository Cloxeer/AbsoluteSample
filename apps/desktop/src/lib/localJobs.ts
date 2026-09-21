/**
 * Tiny module-level registry that lets useAudioEngine record "this job started now, on click"
 * before any backend progress event has arrived, and lets useJobs pick it up immediately so the
 * transport's elapsed timer starts ticking from the moment the user clicked, not from whenever
 * the first backend event happens to land.
 */
type Listener = (trackId: string, startedAt: string) => void;

const listeners = new Set<Listener>();
const starts = new Map<string, string>();

/** Records "now" as the start time for trackId, unless one is already recorded. Returns the recorded ISO time. */
export function markJobStarted(trackId: string): string {
  const existing = starts.get(trackId);
  if (existing) return existing;
  const startedAt = new Date().toISOString();
  starts.set(trackId, startedAt);
  for (const l of listeners) l(trackId, startedAt);
  return startedAt;
}

/** Clears the recorded local start time, e.g. once a job completes or fails. */
export function clearJobStart(trackId: string): void {
  starts.delete(trackId);
}

export function getJobStart(trackId: string): string | undefined {
  return starts.get(trackId);
}

export function onJobStarted(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Earlier of two ISO timestamps (undefined ones are ignored). */
export function earlierIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
