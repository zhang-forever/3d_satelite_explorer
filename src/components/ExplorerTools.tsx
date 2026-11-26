"use client";

import type { ComponentType } from "react";
import {
  Camera,
  HelpCircle,
  Languages,
  RefreshCw,
  RotateCcw,
  RotateCw
} from "lucide-react";

import { IS_SNAPSHOT_MODE } from "@/lib/dataAccess";
import type { Copy, Locale } from "@/lib/i18n";

type ToolRowProps = {
  icon: ComponentType<{ size?: number }>;
  label: string;
  state?: string;
  onClick: () => void;
};

function ToolRow({ icon: Icon, label, state, onClick }: ToolRowProps) {
  return (
    <button className="tool-row" type="button" onClick={onClick}>
      <Icon size={16} />
      <span>{label}</span>
      {state ? <span className="tool-state">{state}</span> : null}
    </button>
  );
}

type ExplorerToolsProps = {
  t: Copy;
  locale: Locale;
  autoRotate: boolean;
  onRefresh: () => void;
  onScreenshot: () => void;
  onOpenShortcuts: () => void;
  onToggleAutoRotate: () => void;
  onToggleLocale: () => void;
  onResetLayout: () => void;
};

export function ExplorerTools({
  t,
  locale,
  autoRotate,
  onRefresh,
  onScreenshot,
  onOpenShortcuts,
  onToggleAutoRotate,
  onToggleLocale,
  onResetLayout
}: ExplorerToolsProps) {
  return (
    <div className="tool-list">
      <ToolRow
        icon={RefreshCw}
        label={IS_SNAPSHOT_MODE ? t.refreshSnapshot : t.refresh}
        onClick={onRefresh}
      />
      <ToolRow icon={Camera} label={t.screenshot} onClick={onScreenshot} />
      <ToolRow icon={HelpCircle} label={t.keyboardShortcuts} onClick={onOpenShortcuts} />
      <ToolRow
        icon={RotateCw}
        label={t.autoRotate}
        state={autoRotate ? "ON" : "OFF"}
        onClick={onToggleAutoRotate}
      />
      <ToolRow
        icon={Languages}
        label={t.language}
        state={locale === "zh" ? "中文" : "EN"}
        onClick={onToggleLocale}
      />
      <ToolRow icon={RotateCcw} label={t.resetLayout} onClick={onResetLayout} />
    </div>
  );
}
