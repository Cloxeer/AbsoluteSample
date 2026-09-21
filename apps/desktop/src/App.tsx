import { useEffect, useMemo, useState } from "react";
import { Transport } from "@/components/layout/Transport";
import { Stepper } from "@/components/layout/Stepper";
import { Tabs } from "@/components/layout/Tabs";
import { SlicerTab } from "@/views/SlicerTab";
import { InspectorTab } from "@/views/InspectorTab";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { backend } from "@/lib/backend";
import type { DependencyReport } from "@/lib/types";

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

  useEffect(() => {
    backend.checkDependencies().then(setDeps);
  }, []);

  const stemOrder = useMemo(() => (engine.stems ?? []).map((s) => s.key), [engine.stems]);

  const completedSteps = useMemo(() => {
    const done: string[] = [];
    if (engine.track) done.push("source");
    if (engine.loop) done.push("loop");
    if (engine.stems) done.push("stems");
    if (engine.analysis) done.push("matrix");
    return done;
  }, [engine.track, engine.loop, engine.stems, engine.analysis]);

  const currentStep = activeTab === "inspector" ? "matrix" : !engine.track ? "source" : !engine.loop ? "loop" : "stems";

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
        onPlayPause={sync.togglePlay}
        onStop={sync.stopAll}
        onToggleLoop={sync.toggleLoop}
        onMasterVolumeChange={setMasterVolume}
      />
      <Stepper steps={PIPELINE_STEPS} currentId={currentStep} completedIds={completedSteps} onStepClick={handleStepClick} />
      <Tabs tabs={TABS} activeId={activeTab} onChange={setActiveTab} />
      <main className="flex-1 pb-10">
        {activeTab === "slicer" ? (
          <SlicerTab engineApi={engineApi} syncApi={sync} />
        ) : (
          <InspectorTab
            track={engine.track}
            loop={engine.loop}
            stems={engine.stems}
            analysis={engine.analysis}
            onAnalyze={() => analyzeLoop(engine.track?.id ?? "")}
          />
        )}
      </main>
    </div>
  );
}
