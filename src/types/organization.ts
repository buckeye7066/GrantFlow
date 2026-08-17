// The single profile GrantFlow keeps for you. Every field is optional so
// saving is never blocked. Stored locally on this device only.

export type OrganizationProfile = {
  id: string;
  name: string;
  mission: string;
  focusAreas: string[];
  focusAreasOther: string;
  whoWeServe: string;
  geographicArea: string;
  annualBudgetRange: string;
  organizationType: string;
  updatedAt: string;
};

// Common focus areas shown as checkboxes. { value } is stored; { label } is shown.
export const FOCUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'education', label: 'Education' },
  { value: 'health', label: 'Health' },
  { value: 'environment', label: 'Environment' },
  { value: 'arts', label: 'Arts & culture' },
  { value: 'community', label: 'Community development' },
  { value: 'youth', label: 'Children & youth' },
  { value: 'seniors', label: 'Older adults' },
  { value: 'housing', label: 'Housing' },
  { value: 'food', label: 'Food & hunger' },
  { value: 'jobs', label: 'Jobs & economic support' },
  { value: 'research', label: 'Research' },
  { value: 'technology', label: 'Technology' },
];

// Friendly money ranges so nobody has to type exact numbers.
export const BUDGET_RANGES: string[] = [
  'Under $50k',
  '$50k-$250k',
  '$250k-$1M',
  'Over $1M',
  'Not sure',
];

// Organization types. { value } is stored; { label } is shown.
export const ORG_TYPES: { value: string; label: string }[] = [
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'business', label: 'Small business' },
  { value: 'school', label: 'School' },
  { value: 'government', label: 'Government office' },
  { value: 'individual/researcher', label: 'Individual / researcher' },
];

// A brand-new, empty profile with safe defaults for every field.
export function emptyProfile(): OrganizationProfile {
  return {
    id: '',
    name: '',
    mission: '',
    focusAreas: [],
    focusAreasOther: '',
    whoWeServe: '',
    geographicArea: '',
    annualBudgetRange: '',
    organizationType: '',
    updatedAt: '',
  };
}

// Fill in any missing fields on a value read from storage, so old or partial
// saved data can never crash the app.
export function normalizeProfile(value: unknown): OrganizationProfile {
  const base = emptyProfile();
  if (!value || typeof value !== 'object') return base;
  const v = value as Record<string, unknown>;
  return {
    id: typeof v.id === 'string' ? v.id : base.id,
    name: typeof v.name === 'string' ? v.name : base.name,
    mission: typeof v.mission === 'string' ? v.mission : base.mission,
    focusAreas: Array.isArray(v.focusAreas)
      ? v.focusAreas.filter((x): x is string => typeof x === 'string')
      : base.focusAreas,
    focusAreasOther:
      typeof v.focusAreasOther === 'string' ? v.focusAreasOther : base.focusAreasOther,
    whoWeServe: typeof v.whoWeServe === 'string' ? v.whoWeServe : base.whoWeServe,
    geographicArea:
      typeof v.geographicArea === 'string' ? v.geographicArea : base.geographicArea,
    annualBudgetRange:
      typeof v.annualBudgetRange === 'string' ? v.annualBudgetRange : base.annualBudgetRange,
    organizationType:
      typeof v.organizationType === 'string' ? v.organizationType : base.organizationType,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : base.updatedAt,
  };
}
