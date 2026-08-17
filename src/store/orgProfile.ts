import { useCallback, useEffect, useState } from 'react';
import {
  OrganizationProfile,
  emptyProfile,
} from '../types/organization';
import {
  loadProfile,
  saveProfile as writeProfile,
  SaveResult,
} from '../lib/storage';

function newId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // fall through to the simple fallback below
  }
  return 'org-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

export type UseOrgProfile = {
  profile: OrganizationProfile | null;
  isLoaded: boolean;
  save: (partial: Partial<OrganizationProfile>) => SaveResult;
};

// Merge the incoming fields onto a base profile, keeping the stable id and
// stamping a fresh updatedAt. Pure helper so it can be reused/tested.
export function buildProfile(
  base: OrganizationProfile | null,
  partial: Partial<OrganizationProfile>,
  id: string,
  now: string,
): OrganizationProfile {
  const start = base ?? emptyProfile();
  return {
    ...start,
    ...partial,
    id: start.id || id,
    updatedAt: now,
  };
}

export function useOrgProfile(): UseOrgProfile {
  const [profile, setProfile] = useState<OrganizationProfile | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
    setIsLoaded(true);
  }, []);

  const save = useCallback(
    (partial: Partial<OrganizationProfile>): SaveResult => {
      let result: SaveResult = { ok: false };
      setProfile((current) => {
        const merged = buildProfile(current, partial, newId(), new Date().toISOString());
        result = writeProfile(merged);
        // Only keep the new value in state if it actually saved, so the UI and
        // storage never disagree after a failed write.
        return result.ok ? merged : current;
      });
      return result;
    },
    [],
  );

  return { profile, isLoaded, save };
}
