# ENV Vars Inventory

This file is **generated** by `node scripts/inventory-env.mjs`.

Run:

- `node scripts/inventory-env.mjs`

It will re-write this file with:
- every env var referenced via `process.env.*` or `import.meta.env.*`
- every env var present in `env.example`, `.env.example`, `backend/env.example`, `backend/.env.example`
- file + line-range usage locations for each var

