import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Transport } from "@/components/layout/Transport";
import { Stepper } from "@/components/layout/Stepper";
import { Tabs } from "@/components/layout/Tabs";
import { SlicerTab } from "@/views/SlicerTab";
import { NotesTab } from "@/views/NotesTab";
import { FrequenciesTab } from "@/views/FrequenciesTab";
import { AutotuneTab } from "@/views/AutotuneTab";
import { LibraryPanel } from "@/components/library/LibraryPanel";
import { SamplesPanel } from "@/components/samples/SamplesPanel";
import { Toast } from "@/components/neumorphic/Toast";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { useJobs } from "@/hooks/useJobs";
import { samplePlayer } from "@/lib/samplePlayer";
import { mixEngine } from "@/lib/mixEngine";
import { nowPlaying } from "@/lib/nowPlaying";
import { backend } from "@/lib/backend";
import { toastStore } from "@/lib/toast";
import type { DependencyReport, LibraryEntry, Sample, TrashEntry } from "@/lib/types";

const TABS = [
  { id: "slicer", label: "Stem Slicer" },
  { id: "inspector", label: "Notes" },
  { id: "frequencies", label: "Frequencies" },
  { id: "autotune", label: "Autotune" },
];

const PIPELINE_STEPS = [
  { id: "source", label: "Source" },
  { id: "loop", label: "Loop" },
  { id: "stems", label: "Stems" },
  { id: "matrix", label: "Notes" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("slicer");
  const [deps, setDeps] = useState<DependencyReport | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  const sync = useSyncPlayback();
  const npState = useSyncExternalStore(nowPlaying.subscribe.bind(nowPlaying), nowPlaying.getState.bind(nowPlaying));
  const engineApi = useAudioEngine();
  const { engine, analyzeLoop } = engineApi;
  const { jobs } = useJobs();

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryEntries, setLibraryEntries] = useState<LibraryEntry[]>([]);
  const [librarySizeBytes, setLibrarySizeBytes] = useState(0);

  const [samplesOpen, setSamplesOpen] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);

  const refreshLibrary = useCallback(async () => {
    const [entries, size] = await Promise.all([backend.listLibrary(), backend.librarySize()]);
    setLibraryEntries(entries);
    setLibrarySizeBytes(size.bytes);
  }, []);

  const refreshSamples = useCallback(async () => {
    setSamples(await backend.listSamples());
  }, []);

  const refreshTrash = useCallback(async () => {
    const entries = await backend.listTrash();
    setTrashEntries(entries);
  }, []);

  useEffect(() => {
    backend.checkDependencies().then(setDeps);
    refreshLibrary();
    refreshSamples();
    refreshTrash();
  }, [refreshLibrary, refreshSamples, refreshTrash]);

  const handleEmptyTrash = useCallback(async () => {
    await backend.emptyTrash();
    refreshTrash();
    refreshLibrary();
  }, [refreshTrash, refreshLibrary]);

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
      const sample = samples.find((s) => s.id === id);
      await backend.deleteSample({ id });
      refreshSamples();
      refreshLibrary();
      refreshTrash();
      toastStore.publish(`Deleted ${sample?.name ?? "sample"}. Undo`, {
        label: "Undo",
        onAction: async () => {
          await backend.restoreTrash({ id });
          refreshSamples();
          refreshLibrary();
          refreshTrash();
        },
      });
    },
    [samples, refreshSamples, refreshLibrary, refreshTrash]
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
      const entry = libraryEntries.find((e) => e.id === id);
      await backend.deleteTrack(id);
      refreshLibrary();
      refreshTrash();
      toastStore.publish(`Deleted ${entry?.title ?? "song"}. Undo`, {
        label: "Undo",
        onAction: async () => {
          await backend.restoreTrash({ id });
          refreshLibrary();
          refreshTrash();
        },
      });
    },
    [libraryEntries, refreshLibrary, refreshTrash]
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
    if (npState.isPlaying) {
      nowPlaying.pause();
    } else if (npState.kind !== null) {
      nowPlaying.resume();
    } else {
      void sync.playMix();
    }
  }, [sync, npState.isPlaying, npState.kind]);

  const transportMode: "mix" | "audition" = npState.kind === null || npState.kind === "mix" ? "mix" : "audition";
  const auditionLabel = useMemo(() => {
    if (transportMode !== "audition") return null;
    if (npState.kind === "audition" && sync.auditionId) {
      return engine.stems?.find((s) => s.key === sync.auditionId)?.label ?? sync.auditionId;
    }
    return npState.label || null;
  }, [transportMode, npState.kind, npState.label, sync.auditionId, engine.stems]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        handlePlayPause();
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
  }, [sync, stemOrder, engine.stems, handlePlayPause]);

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

  const anyJobRunning = Object.keys(jobs).length > 0;
  // Bumped after track fetch/split/delete actions so Transport's storage chip refreshes immediately.
  const storageRefreshSignal = librarySizeBytes + samples.length + trashEntries.length;

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
        isPlaying={npState.isPlaying}
        currentTime={npState.time}
        mode={transportMode}
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
        currentTrackId={engine.track?.id ?? null}
        anyJobRunning={anyJobRunning}
        storageRefreshSignal={storageRefreshSignal}
        onPlayPause={handlePlayPause}
        onStop={() => {
          nowPlaying.stop();
          sync.stopAll();
          samplePlayer.stop();
        }}
        onToggleLoop={sync.toggleLoop}
        onMasterVolumeChange={(v) => {
          setMasterVolume(v);
          mixEngine.setMaster(v);
        }}
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
        trashCount={trashEntries.length}
        trashBytes={trashEntries.reduce((sum, t) => sum + t.bytes, 0)}
        onClose={() => setLibraryOpen(false)}
        onOpenTrack={handleOpenTrack}
        onSetKept={handleSetKept}
        onDeleteTrack={handleDeleteTrack}
        onEmptyTrash={handleEmptyTrash}
      />
      <SamplesPanel
        open={samplesOpen}
        samples={samples}
        onClose={() => setSamplesOpen(false)}
        onRename={handleRenameSample}
        onDelete={handleDeleteSample}
        onReveal={handleRevealSample}
        onExport={handleExportSamples}
        onSaved={refreshSamples}
      />
      <Toast />
      <main className="flex-1 pb-10">
        {activeTab === "slicer" && (
          <SlicerTab
            engineApi={engineApi}
            syncApi={sync}
            onLibraryChanged={refreshLibrary}
            samples={samples}
            onSampleSaved={refreshSamples}
          />
        )}
        {activeTab === "inspector" && (
          <NotesTab
            track={engine.track}
            loop={engine.loop}
            instruments={engine.instruments}
            analysis={engine.analysis}
            onAnalyze={() => analyzeLoop(engine.track?.id ?? "")}
            samples={samples}
          />
        )}
        {activeTab === "frequencies" && (
          <FrequenciesTab
            track={engine.track}
            instruments={engine.instruments}
            analysis={null}
            samples={samples}
          />
        )}
        {activeTab === "autotune" && (
          <AutotuneTab
            track={engine.track}
            instruments={engine.instruments}
            samples={samples}
          />
        )}
      </main>
    </div>
  );
}
