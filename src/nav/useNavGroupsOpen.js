import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { getNavGroupsOpen, setNavGroupsOpen, getGroupIdForRoute } from "./navConfig";
import {
  applyDefaultOpenGroups,
  getNavDefaultsMarkerSeen,
  setNavDefaultsMarkerSeen,
} from "./navGroupsDefaults";

/**
 * Persisted open/closed state for nav groups.
 * Returns [openSet, toggleGroup].
 * Ensures the group containing the current route is open on mount and when route changes.
 *
 * `defaultOpenIds` (optional): group ids to open the FIRST time this browser
 * renders the nav (see navGroupsDefaults.js). The admin workspace passes all
 * of its group ids so every tab is visible out of the box; after that first
 * application the user's own expand/collapse choices win. Callers must pass a
 * stable-content array (the ids join into the effect key).
 */
export function useNavGroupsOpen(defaultOpenIds = null) {
  const location = useLocation();
  const activeGroupId = getGroupIdForRoute(location.pathname);

  const [openSet, setOpenSet] = useState(() => getNavGroupsOpen());

  const defaultsKey = Array.isArray(defaultOpenIds) && defaultOpenIds.length > 0
    ? defaultOpenIds.join(",")
    : "";

  useEffect(() => {
    if (!defaultsKey) return;
    // The user object (and thus the admin defaults) can arrive a beat after
    // mount, so this runs as an effect rather than only in the initializer.
    const next = applyDefaultOpenGroups(
      getNavGroupsOpen(),
      getNavDefaultsMarkerSeen(),
      defaultsKey.split(","),
    );
    setNavDefaultsMarkerSeen();
    if (next) {
      setNavGroupsOpen(next);
      setOpenSet(next);
    }
  }, [defaultsKey]);

  useEffect(() => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      next.add(activeGroupId);
      setNavGroupsOpen(next);
      return next;
    });
  }, [activeGroupId]);

  const persist = useCallback((nextSet) => {
    setNavGroupsOpen(nextSet);
    setOpenSet(nextSet);
  }, []);

  const toggleGroup = useCallback((groupId) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      setNavGroupsOpen(next);
      return next;
    });
  }, []);

  return [openSet, toggleGroup];
}

const ADVANCED_TOOLS_KEY = "grantflow:show-advanced-tools";

export function getShowAdvancedTools() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ADVANCED_TOOLS_KEY) === "true";
}

export function setShowAdvancedTools(value) {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(ADVANCED_TOOLS_KEY, "true");
  else window.localStorage.removeItem(ADVANCED_TOOLS_KEY);
}
