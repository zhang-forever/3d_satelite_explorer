"use client";

import type { ReactNode } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";

import type { Copy } from "@/lib/i18n";

import type { CollapsiblePanelId } from "@/lib/explorer-types";

type PanelToggleButtonProps = {
  panelId: CollapsiblePanelId;
  label: string;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  t: Copy;
};

export function PanelToggleButton({
  panelId,
  label,
  collapsed,
  onToggle,
  t
}: PanelToggleButtonProps) {
  const action = collapsed ? t.expandPanel : t.collapsePanel;

  return (
    <button
      className="icon-button compact"
      type="button"
      aria-expanded={!collapsed}
      aria-label={`${action} ${label}`}
      title={`${action} ${label}`}
      onClick={() => onToggle(panelId)}
    >
      {collapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
    </button>
  );
}

type PanelSectionProps = {
  panelId: CollapsiblePanelId;
  className: string;
  title: ReactNode;
  label: string;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  t: Copy;
  actions?: ReactNode;
  children: ReactNode;
};

/**
 * Shared collapsible panel chrome. `actions` renders inside the title row's
 * action group; panels without actions keep the toggle at the row edge.
 */
export function PanelSection({
  panelId,
  className,
  title,
  label,
  collapsed,
  onToggle,
  t,
  actions,
  children
}: PanelSectionProps) {
  const toggle = (
    <PanelToggleButton
      panelId={panelId}
      label={label}
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
    />
  );

  return (
    <section className={clsx("panel", className, collapsed && "collapsed")}>
      <div className="panel-title collapsible-title">
        <span className="panel-title-main">{title}</span>
        {actions ? (
          <span className="panel-title-actions">
            {actions}
            {toggle}
          </span>
        ) : (
          toggle
        )}
      </div>
      {children}
    </section>
  );
}
