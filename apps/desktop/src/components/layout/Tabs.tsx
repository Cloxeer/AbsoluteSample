import clsx from "clsx";

export interface TabDef {
  id: string;
  label: string;
}

export interface TabsProps {
  tabs: TabDef[];
  activeId: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeId, onChange }: TabsProps) {
  return (
    <div role="tablist" className="flex gap-2 px-6">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={clsx(
              "rounded-2xl px-4 py-2 text-sm font-medium transition-shadow",
              active ? "neu-surface-inset text-accent" : "neu-surface-raised text-muted hover:text-text"
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
