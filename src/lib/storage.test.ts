import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG_PROFILE_STORAGE_KEY, loadProfile, saveProfile } from './storage';
import type { OrganizationProfile } from '../types/organization';

const blankProfile: OrganizationProfile = {
  id: 'profile-1',
  name: '',
  mission: '',
  focusAreas: [],
  focusAreasOther: '',
  whoWeServe: '',
  geographicArea: '',
  annualBudgetRange: '',
  organizationType: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('organization profile storage', () => {
  it('saves and loads a profile', () => {
    expect(saveProfile(blankProfile)).toEqual({ ok: true });
    expect(loadProfile()).toEqual(blankProfile);
  });

  it('returns a friendly failure result when localStorage cannot save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(saveProfile(blankProfile)).toEqual({ ok: false });
  });

  it('returns null when no profile exists', () => {
    expect(loadProfile()).toBeNull();
  });

  it('returns null when saved JSON is broken', () => {
    window.localStorage.setItem(ORG_PROFILE_STORAGE_KEY, '{not json');
    expect(loadProfile()).toBeNull();
  });

  it('fills missing fields with safe defaults', () => {
    window.localStorage.setItem(ORG_PROFILE_STORAGE_KEY, JSON.stringify({ id: 'old-profile' }));

    expect(loadProfile()).toMatchObject({
      id: 'old-profile',
      name: '',
      mission: '',
      focusAreas: [],
      focusAreasOther: '',
      whoWeServe: '',
      geographicArea: '',
      annualBudgetRange: '',
      organizationType: '',
    });
  });

  it('saves when all user-filled fields are blank', () => {
    const result = saveProfile(blankProfile);
    expect(result).toEqual({ ok: true });
    expect(window.localStorage.getItem(ORG_PROFILE_STORAGE_KEY)).toContain('profile-1');
  });
});
