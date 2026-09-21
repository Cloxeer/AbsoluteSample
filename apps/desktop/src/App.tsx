import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Transport } from "@/components/layout/Transport";
import { Stepper } from "@/components/layout/Stepper";
import { Tabs } from "@/components/layout/Tabs";
import { SlicerTab } from "@/views/SlicerTab";
import { InspectorTab } from "@/views/InspectorTab";
import { LibraryPanel } from "@/components/library/LibraryPanel";
import { SamplesPanel } from "@/components/samples/SamplesPanel";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { useJobs } from "@/hooks/useJobs";
import { samplePlayer } from "@/lib/samplePlayer";
import { backend } from "@/lib/backend";
import type { DependencyReport, LibraryEntry, Sample } from "@/lib/types";

const TABS = [
  { id: "slicer", label: "Stem Slicer" },
  { id: "inspector", label: "Loop & Beat Matrix" },
];

const PIPELINE_STEPS = [
  { id: "source", label: "Source" },
  { id: "loop", label: "Loop" },
  { id: "stems", label: "Stems" },
  { id: "matrix", label: "Beat Matrix" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("slicer");
  const [deps, setDeps] = useState<DependencyReport | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  const sync = useSyncPlayback();
  const engineApi = useAudioEngine();
  const { engine, analyzeLoop } = engineApi;
  const { jobs } = useJobs();

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([]);
  const [librarySizeBytes, setLibrarySizeBytes] = useState(0);

  const [samplesOpen, setSamplesOpen] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);

  const refreshLibrary = useCallback(async () => {
    const [entries, size] = await Promise.all([backend.listLibrary(), backend.librarySize()]);
    setLibraryEntries(entries);
    setLibrarySizeBytes(size.bytes);
  }, []);

  const refreshSamples = useCallback(async () => {
    setSamples(await backend.listSamples());
  }, []);

  useEffect(() => {
    backend.checkDependencies().then(setDeps);
    refreshLibrary();
    refreshSamples();
  }, [refreshLibrary, refreshSamples]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === "b") {
        setLibraryOpen((v) => !v);
      } else if (e.key.toLowerCase() === "n") {
        setSamplesOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleRenameSample = useCallback(
    async (id: string, name: string) => {
      await backend.renameSample({ id, name });
      refreshSamples();
    },
    [refreshSamples]
  );

  const handleDeleteSample = useCallback(
    async (id: string) => {
      await backend.deleteSample({ id });
      refreshSamples();
      refreshLibrary();
    },
    [refreshSamples, refreshLibrary]
  );

  const handleRevealSample = useCallback(async (id: string) => {
    await backend.revealSample({ id });
  }, []);

  const handleExportSamples = useCallback(async (ids: string[]) => {
    await backend.exportSamples({ ids });
  }, []);

  const handleOpenTrack = useCallback(
    async (id: string) => {
      await engineApi.openTrack(id, sync.stopAll);
      setLibraryOpen(false);
      refreshLibrary();
    },
    [engineApi, sync.stopAll, refreshLibrary]
  );

  const handleSetKept = useCallback(
    async (id: string, kept: boolean) => {
      await backend.setKept(id, kept);
      refreshLibrary();
    },
    [refreshLibrary]
  );

  const handleDeleteTrack = useCallback(
    async (id: string) => {
      await backend.deleteTrack(id);
      refreshLibrary();
    },
    [refreshLibrary]
  );

  const stemOrder = useMemo(() => (engine.stems ?? []).map((s) => s.key), [engine.stems]);

  const completedSteps = useMemo(() => {
    const done: string[] = [];
    if (engine.track) done.push("source");
    if (engine.loop) done.push("loop");
    if (engine.stems || engine.instruments) done.push("stems");
    if (engine.analysis) done.push("matrix");
    return done;
  }, [engine.track, engine.loop, engine.stems, engine.instruments, engine.analysis]);

  const currentStep = activeTab === "inspector" ? "matrix" : !engine.track ? "source" : !engine.loop ? "loop" : "stems";

  const handlePlayPause = useCallback(() => {
    if (sync.isPlaying) {
      sync.stopAll();
      samplePlayer.stop();
    } else {
      sync.togglePlay();
    }
  }, [sync]);

  const auditionLabel = useMemo(() => {
    if (sync.mode !== "audition" || !sync.auditionId) return null;
    return engine.stems?.find((s) => s.key === sync.auditionId)?.label ?? sync.auditionId;
  }, [sync.mode, sync.auditionId, engine.stems]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        sync.togglePlay();
      } else if (e.key.toLowerCase() === "l") {
        sync.toggleLoop();
      } else if (e.key === "Escape") {
        sync.stopAll();
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        const idx = Number(e.key) - 1;
        const stemKey = stemOrder[idx];
        if (stemKey) sync.auditionTrack(stemKey);
      } else if (e.key.toLowerCase() === "m") {
        const focused = document.activeElement?.closest('[role="group"]');
        const label = focused?.getAttribute("aria-label") ?? "";
        const stem = engine.stems?.find((s) => label.startsWith(s.label));
        if (stem) {
          const current = sync.tracks.find((t) => t.id === stem.key);
          sync.upsertTrack({ id: stem.key, volume: current?.volume ?? 1, solo: current?.solo ?? false, mute: !(current?.mute ?? false) });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sync, stemOrder, engine.stems]);

  // Per-song jobs: when a job for another song finishes, refresh only the library listing.
  const prevJobIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const nowIds = new Set(Object.keys(jobs));
    for (const id of prevJobIdsRef.current) {
      if (!nowIds.has(id) && id !== engine.track?.id) {
        refreshLibrary();
      }
    }
    prevJobIdsRef.current = nowIds;
  }, [jobs, engine.track?.id, refreshLibrary]);

  const otherSongJob = useMemo(() => {
    const entries = Object.values(jobs);
    const other = entries.find((j) => j.trackId !== engine.track?.id);
    if (!other) return null;
    const title = libraryEntries.find((e) => e.id === other.trackId)?.title ?? other.trackId;
    return { ...other, title };
  }, [jobs, engine.track?.id, libraryEntries]);

  const handleStepClick = (id: string) => {
    if (id === "matrix") {
      setActiveTab("inspector");
    } else {
      setActiveTab("slicer");
      requestAnimationFrame(() => {
        document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col gap-4">
      <Transport
        deps={deps}
        isPlaying={sync.isPlaying}
        currentTime={sync.currentTime}
        mode={sync.mode}
        auditionLabel={auditionLabel}
        loopEnabled={sync.loopEnabled}
        bpm={engine.analysis?.bpm ?? null}
        masterVolume={masterVolume}
        progress={engine.progress ? { message: engine.progress.message, percent: engine.progress.percent } : null}
        librarySongCount={libraryEntries.length}
        sampleCount={samples.length}
        currentJob={engine.track ? jobs[engine.track.id] ?? null : null}
        lastSplit={engine.instrumentsMeta ? { elapsedSec: engine.instrumentsMeta.elapsedSec, passSeconds: engine.instrumentsMeta.passSeconds ?? {} } : null}
        otherSongJob={otherSongJob}
        onPlayPause={handlePlayPause}
        onStop={() => {
          sync.stopAll();
          samplePlayer.stop();
        }}
        onToggleLoop={sync.toggleLoop}
        onMasterVolumeChange={setMasterVolume}
        onToggleLibrary={() => setLibraryOpen((v) => !v)}
        onToggleSamples={() => setSamplesOpen((v) => !v)}
      />
      <Stepper steps={PIPELINE_STEPS} currentId={currentStep} completedIds={completedSteps} onStepClick={handleStepClick} />
      <Tabs tabs={TABS} activeId={activeTab} onChange={setActiveTab} />
      <LibraryPanel
        open={libraryOpen}
        entries={libraryEntries}
        currentTrackId={engine.track?.id ?? null}
        sizeBytes={librarySizeBytes}
        jobs={jobs}
        onClose={() => setLibraryOpen(false)}
        onOpenTrack={handleOpenTrack}
        onSetKept={handleSetKept}
        onDeleteTrack={handleDeleteTrack}
      />
      <SamplesPanel
        open={samplesOpen}
        samples={samples}
        onClose={() => setSamplesOpen(false)}
        onRename={handleRenameSample}
        onDelete={handleDeleteSample}
        onReveal={handleRevealSample}
        onExport={handleExportSamples}
      />
      <main className="flex-1 pb-10">
        {activeTab === "slicer" ? (
          <SlicerTab
            engineApi={engineApi}
            syncApi={sync}
            onLibraryChanged={refreshLibrary}
            samples={samples}
            onSampleSaved={refreshSamples}
          />
        ) : (
          <InspectorTab
            track={engine.track}
            loop={engine.loop}
            stems={engine.stems}
            instruments={engine.instruments}
            analysis={engine.analysis}
            onAnalyze={() => analyzeLoop(engine.track?.id ?? "")}
            samples={samples}
            currentTime={sync.currentTime}
            isPlaying={sync.isPlaying}
          />
        )}
      </main>
    </div>
  );
}
