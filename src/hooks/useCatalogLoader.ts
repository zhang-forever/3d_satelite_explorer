"use client";

import { useEffect, useRef, useState } from "react";

import { AVAILABLE_CATALOGS, catalogsDataUrl, groupDataUrl } from "@/lib/dataAccess";
import type { OmmRecord } from "@/lib/orbit";

import { fallbackCatalogs, isApiObject, isOmmRecord, readApiResponse } from "@/lib/explorer-api";
import { DATA_REQUEST_TIMEOUT_MS } from "@/lib/explorer-constants";
import type { CatalogSummary, LoadedGroup } from "@/lib/explorer-types";

/**
 * Catalog metadata plus on-demand group loading.
 *
 * Catalog membership is tracked separately from propagation so the UI can keep
 * an object listed (or hide it) independently of whether the worker has caught
 * up with the latest record set.
 */
export function useCatalogLoader() {
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>(fallbackCatalogs);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadedGroups, setLoadedGroups] = useState<Record<string, LoadedGroup>>({});
  const [loadingGroups, setLoadingGroups] = useState<Record<string, boolean>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const loadedGroupsRef = useRef<Record<string, LoadedGroup>>({});
  const groupRequestsRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const controller = new AbortController();
    // Development StrictMode mounts effects twice. Aborting in the cleanup
    // would cancel a perfectly good request and show net::ERR_ABORTED in the
    // console, so the response is ignored instead of cancelled; only the
    // timeout may abort.
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DATA_REQUEST_TIMEOUT_MS);
    fetch(catalogsDataUrl(), { signal: controller.signal })
      .then(readApiResponse)
      .then((payload) => {
        if (!active || controller.signal.aborted) return;
        if (!Array.isArray(payload.catalogs) || !payload.catalogs.every((catalog) =>
          isApiObject(catalog) && AVAILABLE_CATALOGS.some((known) => known.id === catalog.id) &&
          typeof catalog.cachedCount === "number" && Number.isFinite(catalog.cachedCount) &&
          typeof catalog.stale === "boolean")) throw new Error("Invalid catalog response");
        const summaries = payload.catalogs as CatalogSummary[];
        setCatalogs(fallbackCatalogs().map((known) => {
          const summary = summaries.find((catalog) => catalog.id === known.id);
          return summary ? { ...known, cachedCount: summary.cachedCount,
            fetchedAt: typeof summary.fetchedAt === "string" ? summary.fetchedAt : null,
            checkedAt: typeof summary.checkedAt === "string" ? summary.checkedAt : null,
            sourceUpdatedAt: typeof summary.sourceUpdatedAt === "string" ? summary.sourceUpdatedAt : null,
            stale: summary.stale, error: typeof summary.error === "string" ? summary.error : null } : known;
        }));
      })
      .catch((error: unknown) => {
        if (!active || (controller.signal.aborted && !timedOut)) return;
        setCatalogError(timedOut ? "Catalog request timed out" : error instanceof Error ? error.message : "Unable to load catalogs");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, []);

  const loadGroup = async (groupId: string, force = false) => {
    if (groupRequestsRef.current.has(groupId)) return;
    if (!force && loadedGroupsRef.current[groupId]) return;
    const catalog = AVAILABLE_CATALOGS.find((item) => item.id === groupId);
    if (!catalog) return;
    const controller = new AbortController();
    groupRequestsRef.current.set(groupId, controller);
    const isCurrentRequest = () => groupRequestsRef.current.get(groupId) === controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DATA_REQUEST_TIMEOUT_MS);
    setLoadingGroups((current) => ({ ...current, [groupId]: true }));
    setLoadErrors((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    try {
      const response = await fetch(groupDataUrl(groupId, force), { signal: controller.signal });
      const payload = await readApiResponse(response);
      if (!isCurrentRequest() || controller.signal.aborted) return;
      if (!isApiObject(payload.group) || payload.group.id !== groupId ||
          !Array.isArray(payload.records) || !payload.records.every(isOmmRecord)) {
        throw new Error("Invalid GP catalog response");
      }
      loadedGroupsRef.current = {
        ...loadedGroupsRef.current,
        [groupId]: {
          catalog,
          records: payload.records,
          fetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : null,
          checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : null,
          sourceUpdatedAt: typeof payload.sourceUpdatedAt === "string" ? payload.sourceUpdatedAt : null,
          stale: Boolean(payload.stale),
          cacheState: typeof payload.cacheState === "string" ? payload.cacheState : "miss",
          error: typeof payload.error === "string" ? payload.error : null
        }
      };
      setLoadedGroups(loadedGroupsRef.current);
      setCatalogError(null);
      setCatalogs((current) =>
        current.map((catalog) =>
          catalog.id === groupId
            ? {
                ...catalog,
                cachedCount: (payload.records as OmmRecord[]).length,
                fetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : catalog.fetchedAt,
                checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : null,
                sourceUpdatedAt: typeof payload.sourceUpdatedAt === "string" ? payload.sourceUpdatedAt : catalog.sourceUpdatedAt,
                stale: Boolean(payload.stale),
                error: typeof payload.error === "string" ? payload.error : null
              }
            : catalog
        )
      );
    } catch (error) {
      if (!isCurrentRequest() || (controller.signal.aborted && !timedOut)) return;
      setLoadErrors((current) => ({
        ...current,
        [groupId]: timedOut ? "Data request timed out" : error instanceof Error ? error.message : "Unable to load catalog"
      }));
    } finally {
      window.clearTimeout(timeout);
      if (isCurrentRequest()) {
        groupRequestsRef.current.delete(groupId);
        setLoadingGroups((current) => ({ ...current, [groupId]: false }));
      }
    }
  };

  const unloadGroup = (groupId: string) => {
    groupRequestsRef.current.get(groupId)?.abort();
    groupRequestsRef.current.delete(groupId);
    const next = { ...loadedGroupsRef.current };
    delete next[groupId];
    loadedGroupsRef.current = next;
    setLoadedGroups(next);
    setLoadingGroups((current) => ({ ...current, [groupId]: false }));
    setLoadErrors((current) => {
      if (!current[groupId]) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    if (loadingGroups[groupId]) return;
    if (loadedGroups[groupId]) {
      unloadGroup(groupId);
    } else {
      // A group that previously failed should retry immediately instead of
      // returning the stored cooldown error until the cooldown expires.
      void loadGroup(groupId, Boolean(loadErrors[groupId]));
    }
  };

  useEffect(() => {
    // 先发出默认分组的请求，保证画面在 ~800ms 内出现卫星，不会空窗。
    const defaults = AVAILABLE_CATALOGS.filter((item) => item.defaultSelected);
    for (const catalog of defaults.length ? defaults : AVAILABLE_CATALOGS.slice(0, 1)) {
      void loadGroup(catalog.id);
    }

    // 默认全选：在主线程空闲时再把剩余分组拉上。已经在请求中或已加载的
    // 分组会被 loadGroup 内部短路跳过，不会重复发起。分批发出既避免首屏
    // 空窗期，也不让上游 CelesTrak 被瞬时 18 路并发直接打挂。
    let cancelled = false;
    const kick = () => {
      if (cancelled) return;
      for (const catalog of AVAILABLE_CATALOGS) {
        if (groupRequestsRef.current.has(catalog.id)) continue;
        if (loadedGroupsRef.current[catalog.id]) continue;
        void loadGroup(catalog.id);
      }
    };
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(kick, { timeout: 3000 });
    } else {
      window.setTimeout(kick, 500);
    }

    // No abort on cleanup: StrictMode remounts this effect immediately and
    // cancelling the in-flight download only produced net::ERR_ABORTED. Late
    // replies are still discarded by `isCurrentRequest`, and the timeout in
    // `loadGroup` aborts a stalled request.
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshLoaded = async () => {
    await Promise.all(Object.keys(loadedGroups).map((groupId) => loadGroup(groupId, true)));
  };

  const loadAllGroups = () => {
    for (const catalog of AVAILABLE_CATALOGS) {
      if (loadingGroups[catalog.id]) continue;
      if (!loadedGroups[catalog.id]) void loadGroup(catalog.id, Boolean(loadErrors[catalog.id]));
    }
  };

  /** Explicit retry from the error banner: bypasses the server-side cooldown. */
  const retryAllGroups = () => {
    for (const catalog of AVAILABLE_CATALOGS) {
      if (!loadingGroups[catalog.id]) void loadGroup(catalog.id, true);
    }
  };

  const unloadAllGroups = () => {
    for (const controller of groupRequestsRef.current.values()) controller.abort();
    groupRequestsRef.current.clear();
    loadedGroupsRef.current = {};
    setLoadedGroups({});
    setLoadingGroups({});
    setLoadErrors({});
  };

  return {
    catalogs,
    catalogError,
    loadedGroups,
    loadingGroups,
    loadErrors,
    toggleGroup,
    refreshLoaded,
    loadAllGroups,
    retryAllGroups,
    unloadAllGroups
  };
}
