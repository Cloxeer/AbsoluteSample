import { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
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

export default function App() {
  const [activeTab, setActiveTab] = useState("slicer");
  const [deps, setDeps] = useState<DependencyReport | null>(null);
  const sync = useSyncPlayback();
  const engineApi = useAudioEngine();
  const { engine, analyzeLoop } = engineApi;

  useEffect(() => {
    backend.checkDependencies().then(setDeps);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        sync.togglePlay();
      } else if (e.key.toLowerCase() === "l") {
        sync.toggleLoop();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sync]);

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col gap-4">
      <Header
        deps={deps}
        isPlaying={sync.isPlaying}
        currentTime={sync.currentTime}
        onPlayPause={sync.togglePlay}
        onStop={sync.stop}
      />
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
