"use client";

import type { Copy } from "@/lib/ui/i18n";

type ShortcutsOverlayProps = {
  t: Copy;
  onClose: () => void;
};

export function ShortcutsOverlay({ t, onClose }: ShortcutsOverlayProps) {
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-panel" onClick={(event) => event.stopPropagation()}>
        <div className="shortcuts-header">
          <h2>{t.keyboardShortcuts}</h2>
          <button className="icon-button compact" type="button" onClick={onClose} title={t.close}>
            ✕
          </button>
        </div>
        <div className="shortcuts-body">
          <div className="shortcut-row">
            <kbd>?</kbd>
            <span>{t.keyboardShortcuts}</span>
          </div>
          <div className="shortcut-row">
            <kbd>Space</kbd>
            <span>{t.spacePause}</span>
          </div>
          <div className="shortcut-row">
            <kbd>+</kbd> / <kbd>-</kbd>
            <span>{t.plusMinusSpeed}</span>
          </div>
          <div className="shortcut-row">
            <kbd>L</kbd>
            <span>{t.lLanguage}</span>
          </div>
          <div className="shortcut-row">
            <kbd>A</kbd>
            <span>{t.keyboardAutoRotate}</span>
          </div>
          <div className="shortcut-row">
            <kbd>S</kbd>
            <span>{t.keyboardRescan}</span>
          </div>
          <div className="shortcut-row">
            <kbd>1</kbd> – <kbd>9</kbd>
            <span>{t.selectCatalog}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
