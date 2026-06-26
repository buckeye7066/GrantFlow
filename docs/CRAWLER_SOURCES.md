# Crawler Sources

The active source registry is Crawler OS:

- `backend/crawler-os/sourceRegistry.js`
- `backend/crawler-os/adapters/`

Source rules:

- Each source must declare its real source URL and trust/kind metadata.
- Directory sources must be labeled as directories.
- API-keyed sources must skip honestly when credentials are unavailable.
- Sources are selected from the active profile thesis, not from a profile-free national sweep.

Validation:

```bash
npm run crawler-os:lint
npm run crawler:verify
```

Retired note:

The old National Crawler V2 registry is not the live source registry. Do not add new discovery sources there.
