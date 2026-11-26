"use client";

import { useEffect, useRef } from "react";

import type { Copy } from "@/lib/i18n";

type ShortcutsOverlayProps = {
  t: Copy;
  onClose: () => void;
};

export function ShortcutsOverlay({ t, onClose }: ShortcutsOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    // Mount-only: keep focus in the dialog and let Escape close it. Depending
    // on `onClose` would re-focus on every parent render (the scene ticks at
    // 1 Hz), stealing focus from keyboard users.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcuts-header">
          <h2 id="shortcuts-title">{t.keyboardShortcuts}</h2>
          <button
            ref={closeRef}
            className="icon-button compact"
            type="button"
            onClick={onClose}
            title={t.close}
            aria-label={t.close}
          >
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
            <kbd>1</kbd> – <kbd>0</kbd> / <kbd>Q</kbd> – <kbd>I</kbd>
            <span>{t.selectCatalog}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
