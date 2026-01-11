# `.env.development.local` template (do not commit secrets)

This repo intentionally does **not** track `.env.*.local` files.

If you need a local-only dev override, create a file named `.env.development.local` in the repo root and paste the template below.

```dotenv
# GrantFlow dev overrides (TEMPLATE)
# Copy to `.env.development.local` to override `.env` / `.env.example` for local-only settings.
# NOTE: Do not commit real secrets.

# Example: point Vite dev proxy at a different backend
# VITE_API_PROXY_TARGET=http://localhost:8080

# Example: widen smoke defaults when debugging
# SMOKE_MAX_ROUTES=10
# SMOKE_MAX_CLICKS=50
# SMOKE_ROUTE_CLICK_BUDGET_MS=30000
```

