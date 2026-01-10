# Defect Ledger

Rules:
- **No claim without evidence**: either a failing log under `artifacts/` OR a provable static crash path.
- Each entry includes: **[ID] [Severity] [Component] [Repro] [Verbatim Trace] [Root Cause Snippet] [Fix] [Verification]**.

---

## [D-001] [High] [Frontend] Vite runtime crash: `process` is not defined in browser bundles

### Repro

- Start frontend and open any route that imports modules using `process.env` in the browser bundle.

### Verbatim Trace

- **Provable static crash path**: Vite does not provide a `process` global in the browser bundle by default; accessing `process.env.*` can throw `ReferenceError: process is not defined`.

### Root Cause Snippet

```1:31:src/lib/firebase.js
import { initializeApp, getApps } from "firebase/app"
import { getFirestore } from "firebase/firestore"

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
}
```

### Fix

- Replace frontend `process.env.*` with `import.meta.env.VITE_*` and `import.meta.env.PROD`.

### Verification

- `npm run build` succeeds.
- `npm run smoke` produces no console errors.

---

## [D-002] [Medium] [Tooling] ESLint blocked due to empty `catch {}` blocks

### Repro

- `npm run lint`

### Verbatim Trace

- ESLint `no-empty` errors (files/lines recorded in the lint output logs under `artifacts/YYYY-MM-DD/lint.log`).

### Root Cause Snippet

```660:668:backend/routes/admin.js
        let oppKeywords = [], oppCategories = [];
        try { oppKeywords = JSON.parse(opp.keywords || '[]'); } catch (e) {}
        try { oppCategories = JSON.parse(opp.categories || '[]'); } catch (e) {}
```

### Fix

- Replace empty catch blocks with explicit best-effort comments or safe fallbacks.

### Verification

- `npm run lint` exits 0 (warnings are allowed).

---

## Blockers to Goal

- Doctor/smoke automation + artifact capture must exist and run green on a clean machine.
- Missing env templates (`.env.example`, `backend/.env.example`) prevent consistent local startup; doctor must provide safe dev defaults.

