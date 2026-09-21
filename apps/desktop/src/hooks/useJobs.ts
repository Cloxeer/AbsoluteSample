import { useEffect, useRef, useState } from "react";
import { onProgress } from "@/lib/events";
import { clearJobStart, earlierIso, getJobStart, onJobStarted } from "@/lib/localJobs";
import type { Job, ProgressPayload } from "@/lib/types";

const TICK_MS = 250;

/**
 * Builds a live, honest view of in-flight jobs keyed by trackId from progress events.
 * elapsedSec ticks every 250ms from the job's real startedAt timestamp (never a fake estimate).
 * startedAt reflects the moment the user clicked (see lib/localJobs), not whenever the first
 * backend progress event happens to arrive: it's the EARLIER of the local click time and whatever
 * startedAt the backend itself reports.
 * A job is cleared when its stage reports 100% (completion) or a failure.
 */
export function useJobs() {
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // Seed a job the instant a local action starts it, before any backend event arrives.
  useEffect(() => {
    return onJobStarted((trackId, startedAt) => {
      setJobs((prev) => {
        if (prev[trackId]) return prev;
        const next: Job = {
          trackId,
          stage: "start",
          percent: 0,
          message: "Starting...",
          startedAt,
          elapsedSec: (Date.now() - Date.parse(startedAt)) / 1000,
        };
        return { ...prev, [trackId]: next };
      });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    onProgress((payload: ProgressPayload) => {
      if (cancelled) return;
      const trackId = payload.trackId;
      if (!trackId) return;

      const isDone = payload.percent >= 100 || payload.failed;
      setJobs((prev) => {
        if (isDone) {
          clearJobStart(trackId);
          if (!(trackId in prev)) return prev;
          const next = { ...prev };
          delete next[trackId];
          return next;
        }
        const startedAt =
          earlierIso(earlierIso(payload.startedAt, getJobStart(trackId)), prev[trackId]?.startedAt) ??
          new Date().toISOString();
        const next: Job = {
          trackId,
          stage: payload.stage,
          pass: payload.pass,
          percent: payload.percent,
          message: payload.message,
          startedAt,
          elapsedSec: payload.elapsedSec ?? (Date.now() - Date.parse(startedAt)) / 1000,
          passSeconds: payload.passSeconds ?? prev[trackId]?.passSeconds,
        };
        return { ...prev, [trackId]: next };
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setJobs((prev) => {
        const ids = Object.keys(prev);
        if (ids.length === 0) return prev;
        const next: Record<string, Job> = {};
        for (const id of ids) {
          const job = prev[id];
          next[id] = { ...job, elapsedSec: (Date.now() - Date.parse(job.startedAt)) / 1000 };
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  return { jobs };
}
