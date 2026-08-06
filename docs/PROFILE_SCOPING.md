# Profile scoping invariants

GrantFlow runs a single account session that can hold many profiles
(individuals, organisations, the virtual `__admin__` profile, etc.). When the
active profile changes, every piece of profile-bound state — including
matching results, pipeline rows, persisted Zustand stores, React-Query
caches, localStorage keys, and the in-flight crawler payload — must follow.

The bug behind these invariants:

- `localStorage` was holding 518 cached results tagged `profile-demo_senior_family`
  while the active profile was `__admin__`.
- `/api/matching/profile/<individual-id>/opportunities` was returning NSF /
  USDA / federal-only programs that the pipeline writer then rejected with
  `400 source_not_allowed` and `400 ineligible_for_profile`.
- Switching profiles in `DiscoverGrants` left a parallel `selectedProfileId`
  state that never called `authStore.setActiveProfileId()`, so caches /
  storage / React-Query never knew the profile had moved.

The contract below codifies what the codebase now enforces. Every PR that
touches profile-bound state must keep these invariants intact.

## Invariants

### 1. The active profile id is the single source of truth

- `useAuthStore.getState().activeProfileId` (or the
  `useActiveProfileId()` hook) is the **only** id any page should read.
- Pages must NOT keep their own `selectedProfileId` state. URL params and
  dropdowns must call `authStore.setActiveProfileId(newId)` so the global
  cache / storage eviction fires.
- The id is persisted at `grantflow:active-profile-id` so a hard reload
  keeps the same active profile.

### 2. Every profile-bound piece of state is keyed by profile id

- localStorage keys are namespaced via
  `scopedKey(profileId, suffix)` from `src/utils/profileScopedStorage.js`.
- Persisted Zustand stores (`fundingResultsStore`, etc.) stamp the
  `profileId` at write time and expose `getResultsForProfile(id)` so reads
  return an empty view on mismatch.
- On hydrate, stores compare the stored profileId against the persisted
  active profile id and self-evict when they disagree.

### 3. Switching the active profile evicts all profile-scoped caches

- `authStore.setActiveProfileId(newId)` calls
  `clearAllProfileScopedStorage()` and removes every React-Query cache
  entry whose `queryKey` mentions the previous profile id (also any
  query whose first key element is one of the profile-bound prefixes:
  `discover-catalog`, `discover-profile`, `matcher-opportunities`,
  `matching-opportunities`, `smart-matcher`, `funding-results`,
  `reverse-lookup`, `profile-pipeline`).
- The query client is registered with the auth store at app boot via
  `registerQueryClient(qc)` from `src/main.jsx`.
- Logout (`clearState()`) does the same eviction.

### 4. Every API that consumes a profile must hard-filter by applicant_type

- `GET /api/matching/profile/:profileId/opportunities` resolves the
  profile's `applicant_type || primary_type || basic.profile_category`
  and applies two **hard** gates before scoring:
  1. `evaluatePipelineSource({source, record_origin})` — symmetry with
     pipeline writer (no surfacing what the writer rejects).
  2. `evaluateApplicantTypeEligibility(opp, profileApplicantType)` —
     drops opportunities whose explicit `applicant_types` array or
     exclusivity phrasing (institution-only, federal-agency-only,
     501(c)(3)-only, etc.) is hard-incompatible with the profile bucket.
     Soft mismatches still flow through and lose score in the existing
     decision engine.
- The same two gates run inside `services/opportunityMatcher.js`
  (`saveToProfilePipeline` + `processCrawledOpportunities`) and
  `routes/grants.js` `POST /api/grants/from-opportunity`.
- The matching response includes a
  `coverage_summary.dropped_ineligible_count` field so the UI can show
  "N opportunities filtered as ineligible for this profile" instead of
  silently dropping rows.

### 5. React-Query keys include the active profile id

- Profile-bound `useQuery` keys must include the profile id as a
  discrete element, e.g.
  `['discover-catalog', activeProfileId, minMatchScore]`.
- This keeps unrelated profiles' cached responses separate and lets the
  predicate-based eviction in `setActiveProfileId()` work.

## Adding a new profile-bound feature

1. Read the active profile id via `useActiveProfileId()`. Do not introduce
   a parallel local id.
2. If you persist anything to `localStorage`, route it through
   `scopedKey(profileId, suffix)` and add the prefix to
   `PER_ID_PROFILE_KEY_PREFIXES` so the global eviction sweep can find it.
3. If you call a backend route that uses the profile, include the id in
   your React-Query key (`['my-feature', activeProfileId, ...]`).
4. If your backend route returns scored opportunities, run
   `evaluatePipelineSource` and `evaluateApplicantTypeEligibility` before
   scoring — both helpers are idempotent and shared between the matcher,
   the pipeline writer, and the cleanup scripts.
