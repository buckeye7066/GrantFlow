# Target Colleges Cards — QA Script

## Overview

This document provides manual QA steps for the Target Colleges → University Cards feature.

## Prerequisites

- Dev server running (`npm run dev` and `npm run backend`)
- At least one student profile with Education section populated

## Phase 1: Auto-Sync (target_colleges → university_applications)

### Steps

1. Navigate to a **student profile** (primary_type includes `student`).
2. Open **Profile Information** tab.
3. Edit the **Education** section — set "Target colleges (list)" to: `Ohio State University, University of Michigan, Harvard`
4. Save the Education section.
5. Switch to the **Universities** tab.

### Expected Results

- University cards appear for Ohio State University, University of Michigan, and Harvard.
- Each card shows status "Planning".
- No duplicate cards when refreshing the page.

### Regression Check

- Refresh the profile page. Target colleges should NOT create duplicate application cards.

---

## Phase 2: Target Colleges Display as Cards

### Steps

1. Navigate to a student profile with target_colleges populated.
2. On **Profile Information** tab, locate the **Education** section card.
3. Confirm that target colleges are shown as a **card grid** (not plain comma-separated text).
4. Click **"View in Universities"**.

### Expected Results

- Each college appears in a small card with graduation cap icon.
- "View in Universities" switches to the Universities tab.
- Clicking the button does not open a new page.

---

## Phase 3: Local Funding (25-Mile Hook)

### Steps

1. Navigate to a student profile.
2. Open **Universities** tab.
3. Add or edit a university application.
4. Set the **ZIP** field (e.g. `43210` for Columbus, OH). Save.
5. In the same application card, find the **Local funding (25 miles)** section.
6. Click **"Fetch local funding (25 miles)"**.

### Expected Results

- Button shows "Fetching…" during load.
- Either a list of local resources appears, or an explicit error message (toast).
- No console spam; errors are surfaced via toast.

### Without ZIP

- If ZIP is empty, the section shows: "ZIP needed to fetch local funding. Add campus ZIP in Edit to fetch nearby resources."

---

## API Example

```bash
# Valid request
curl -s "http://localhost:8080/api/colleges/local-funding?zip=43210&radiusMiles=25" | jq .

# Missing zip (expect 400)
curl -s "http://localhost:8080/api/colleges/local-funding" | jq .

# Invalid zip (expect 400)
curl -s "http://localhost:8080/api/colleges/local-funding?zip=bad" | jq .
```

### Expected Response Shape (200)

```json
{
  "success": true,
  "zip": "43210",
  "radiusMiles": 25,
  "radiusFilteringApplied": false,
  "results": [
    {
      "title": "United Way near Columbus, OH",
      "url": "https://www.unitedway.org/find-your-united-way",
      "source": "United Way Locator",
      "distanceMiles": null
    }
  ],
  "request_id": "local-..."
}
```

---

## Test Commands

```bash
# Run unit tests
npm run unit

# Or specifically:
node --test tests/unit/target-colleges-sync.test.mjs
node --test tests/unit/colleges-local-funding-route.test.mjs
```

---

## Screenshots (Optional)

- Before: Education section with plain "Target colleges (list)" text area.
- After: Education section with card grid + "View in Universities" button.
- Universities tab with auto-created cards from target_colleges.
- Local funding section with "Fetch local funding (25 miles)" button and results.
