import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { getNavGroupsOpen, setNavGroupsOpen, getGroupIdForRoute } from "./navConfig";

/**
 * Persisted open/closed state for nav groups.
 * Returns [openSet, toggleGroup].
 * Ensures the group containing the current route is open on mount and when route changes.
 */
export function useNavGroupsOpen() {
  const location = useLocation();
  const activeGroupId = getGroupIdForRoute(location.pathname);

  const [openSet, setOpenSet] = useState(() => getNavGroupsOpen());

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
