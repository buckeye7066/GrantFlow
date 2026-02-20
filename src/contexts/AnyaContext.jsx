/**
 * Anya Context: non-sensitive UI state for the AI copilot (when ANYA_COPILOT_ENABLED).
 * No user private text is captured. Updates are driven by route/auth only (no keystroke);
 * no throttle needed as location and authStore subscriptions do not fire on every key press.
 */
/* eslint-disable react-refresh/only-export-components -- context + hooks exported from same file */
import React, { createContext, useContext, useCallback, useMemo, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

/** @typedef {{ type: "navigate" | "invokeTool" | "openModal", label: string, payload: { path?: string, toolName?: string, parameters?: Record<string, unknown> } }} AnyaAction */
/** @typedef {{ pageType?: string, primaryEntityId?: string, completion?: Record<string, unknown>, suggestedActions?: AnyaAction[] }} PageAdapterState */
/** @typedef {{ route: string, search: string, activeProfileId: string | null, pageName: string, activeObject: Record<string, string>, adapter: PageAdapterState | null, setAdapterContext: (s: PageAdapterState | null) => void }} AnyaContextValue */

const AnyaContext = createContext(null);

function pathnameToPageName(pathname) {
  const segment = (pathname || "/").replace(/^\//, "").split("/")[0] || "Dashboard";
  return segment;
}

function deriveActiveObject(pathname, search) {
  const params = new URLSearchParams(search || "");
  const page = pathnameToPageName(pathname);
  const active = {};
  if (page === "GrantDetail" || page === "Apply") {
    const id = params.get("id") || params.get("grantId");
    if (id) active.grantId = id;
  }
  if (page === "VNextApplication") {
    const id = params.get("id");
    if (id) active.proposalId = id;
  }
  if (page === "ProfileDetail" || page === "OrganizationProfile") {
    const id = params.get("id");
    if (id) active.profileId = id;
  }
  if (page === "Pipeline" || page === "DiscoverGrants" || page === "Documents") {
    const profileId = params.get("profile_id");
    if (profileId) active.profileId = profileId;
  }
  return active;
}

export function AnyaContextProvider({ children }) {
  const location = useLocation();
  const activeProfileId = useAuthStore((state) => state.activeProfileId ?? null);

  const route = location.pathname || "/";
  const search = location.search?.replace(/^\?/, "") || "";
  const pageName = pathnameToPageName(route);
  const activeObject = useMemo(
    () => deriveActiveObject(route, search),
    [route, search],
  );

  const [adapterState, setAdapterState] = React.useState(null);

  const setAdapterContext = useCallback((state) => {
    setAdapterState((prev) => (state === null ? null : { ...prev, ...state }));
  }, []);

  useEffect(() => {
    setAdapterState(null);
  }, [route]);

  const value = useMemo(
    () => ({
      route,
      search,
      activeProfileId: activeProfileId ?? null,
      pageName,
      activeObject,
      adapter: adapterState,
      setAdapterContext,
    }),
    [route, search, activeProfileId, pageName, activeObject, adapterState, setAdapterContext],
  );

  return <AnyaContext.Provider value={value}>{children}</AnyaContext.Provider>;
}

export function useAnyaContext() {
  const ctx = useContext(AnyaContext);
  if (!ctx) {
    return {
      route: "/",
      search: "",
      activeProfileId: null,
      pageName: "Dashboard",
      activeObject: {},
      adapter: null,
      setAdapterContext: () => {},
    };
  }
  return ctx;
}

/**
 * Hook for page adapter bridge (only mount bridge when copilot enabled).
 */
export function useAnyaPageAdapter(adapterState) {
  const { setAdapterContext } = useAnyaContext();
  useEffect(() => {
    if (!adapterState) return;
    setAdapterContext(adapterState);
    return () => setAdapterContext(null);
  }, [setAdapterContext, adapterState]);
}

/**
 * Serialize context for "Use current screen" (no PII).
 */
export function serializeAnyaContext(context) {
  const { route, search, activeProfileId, pageName, activeObject, adapter } = context;
  return {
    route,
    search,
    activeProfileId: activeProfileId ?? null,
    pageName,
    activeObject: { ...activeObject },
    pageType: adapter?.pageType ?? null,
    primaryEntityId: adapter?.primaryEntityId ?? null,
    completion: adapter?.completion ? { ...adapter.completion } : null,
    suggestedActionsCount: adapter?.suggestedActions?.length ?? 0,
  };
}
