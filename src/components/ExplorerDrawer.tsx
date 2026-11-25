"use client";

import type { ReactNode } from "react";

type ExplorerDrawerProps = {
  title: string;
  closeLabel: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
};

/** One page of the rail: a header, optional actions, and scrollable content. */
export function ExplorerDrawer({
  title,
  closeLabel,
  onClose,
  actions,
  children
}: ExplorerDrawerProps) {
  return (
    <aside className="drawer" aria-label={title}>
      <div className="drawer-header">
        <span className="drawer-title">{title}</span>
        <span className="drawer-actions">
          {actions}
          <button
            className="icon-button compact"
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            ✕
          </button>
        </span>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
