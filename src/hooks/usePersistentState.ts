"use client";

import { useCallback, useSyncExternalStore } from "react";

// A tiny localStorage-backed store exposed through `useSyncExternalStore`.
// Reading storage during an effect and calling setState would trigger a second
// render pass on mount (and React flags it); going through an external store
// lets React reconcile the server snapshot with the stored value in one go.

type PreferenceListener = () => void;

const preferenceListeners = new Map<string, Set<PreferenceListener>>();
const preferenceCache = new Map<string, unknown>();

function readPreference<T>(key: string, fallback: T): T {
  if (preferenceCache.has(key)) return preferenceCache.get(key) as T;
  if (typeof window === "undefined") return fallback;
  let value = fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) value = JSON.parse(raw) as T;
  } catch {
    // ignore corrupt or unavailable storage
  }
  preferenceCache.set(key, value);
  return value;
}

function subscribePreference(key: string, listener: PreferenceListener) {
  let bucket = preferenceListeners.get(key);
  if (!bucket) {
    bucket = new Set<PreferenceListener>();
    preferenceListeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
  };
}

function writePreference<T>(key: string, value: T) {
  preferenceCache.set(key, value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage may be full or disabled
    }
  }
  preferenceListeners.get(key)?.forEach((listener) => listener());
}

/**
 * State that survives a reload.
 *
 * `serverValue` is what the server renders *and* what hydration expects, so it
 * must not depend on the browser (use "zh", not the detected language).
 * `clientValue` is the fallback used once running in the browser when nothing
 * was stored yet — pass a primitive only, it is part of the snapshot identity.
 */
export function usePersistentState<T>(key: string, serverValue: T, clientValue?: T) {
  const fallback = clientValue === undefined ? serverValue : clientValue;
  const getSnapshot = useCallback(() => readPreference(key, fallback), [key, fallback]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);
  const subscribe = useCallback(
    (listener: PreferenceListener) => subscribePreference(key, listener),
    [key]
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const current = readPreference(key, fallback);
      writePreference(key, typeof next === "function" ? (next as (input: T) => T)(current) : next);
    },
    [key, fallback]
  );

  return [value, setValue] as const;
}
