import React from 'react';
import { AppTab } from '../core/types';

interface TopBarProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onQuickImport: () => void;
}

const NAV_ITEMS: Array<{ id: AppTab; label: string }> = [
  { id: 'studio', label: 'Studio' },
  { id: 'dreams-parser', label: 'Dreams Parser' },
  { id: 'rig-tree', label: 'Rig Tree' },
  { id: 'export', label: 'Export' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onQuickImport,
}) => {
  return (
    <header className="h-14 shrink-0 border-b border-white/[0.08] bg-[#16181D] px-6 flex items-center justify-between gap-8">
      <a
        href="#studio"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('studio');
        }}
        className="font-display text-base font-semibold tracking-tight text-gray-100 whitespace-nowrap shrink-0"
      >
        Bytruvyus Forge
      </a>

      <nav className="flex items-center gap-7" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`relative py-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded ${
                active
                  ? 'text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {item.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-[15px] h-0.5 bg-violet-500"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onQuickImport}
          className="px-4 py-2 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 active:bg-violet-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          Import .drm / Rig
        </button>
      </div>
    </header>
  );
};
