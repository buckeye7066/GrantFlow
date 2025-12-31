# GrantFlow Path 2 Deployment (Vercel + Railway + Cloudflare)

## Goal
Serve the app at `https://www.axiombiolabs.org/grantflow` and `https://axiombiolabs.org/grantflow` with:
- Frontend (Vercel) under `/grantflow/*`
- Backend (Railway) under `/api/*`

## Current Deployment Status

- ✅ **Vercel Frontend:** Deployed and working at `app.axiombiolabs.org/grantflow`
- ✅ **Railway Backend:** Running at `grantflow-production.up.railway.app`
- ⏳ **Root Domain:** Pending DNS migration to point to Vercel
- ⏳ **WWW Domain:** Pending DNS migration to point to Vercel

---

## DNS Configuration

### Next Steps Required

To complete the migration and make the app available at the root domain:

📘 **[Complete DNS Migration Guide](docs/DNS_MIGRATION.md)** - Follow this guide to:
1. Add custom domains (`axiombiolabs.org` and `www.axiombiolabs.org`) in Vercel
2. Configure DNS records in your provider (GoDaddy or Cloudflare)
3. Update Railway CORS settings
4. Verify and test the migration

✅ **[Domain Migration Checklist](docs/VERCEL_DOMAIN_CHECKLIST.md)** - Use this checklist for:
- Pre-migration verification
- Step-by-step execution
- Post-migration testing
- Rollback procedures if needed

### DNS Configuration Summary

**For GoDaddy:**
```
Type    Name    Value                    TTL
----------------------------------------------
CNAME   www     cname.vercel-dns.com    600
A       @       [Vercel IP]             600
```

**For Cloudflare:**
```
Type    Name    Target                  Proxy      TTL
--------------------------------------------------------
CNAME   www     cname.vercel-dns.com    DNS only   Auto
CNAME   @       cname.vercel-dns.com    DNS only   Auto
```

> ⚠️ **Important:** When using Cloudflare, disable the proxy (gray cloud icon) to avoid conflicts with Vercel's edge network.

---

## Architecture Details

## 1) Vercel
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`

This repo is already configured for production base path `/grantflow/` via `vite.config.ts`.

## 2) Railway
- Start command: `npm run start`
- Required env:
  - `NODE_ENV=production`
  - `ANYA_ADMIN_TOKEN=...`
  - `CORS_ORIGIN=https://www.axiombiolabs.org,https://app.axiombiolabs.org`

## 3) Cloudflare Origin Rules
Create two Origin Rules:

### Rule A (API)
If path starts with `/api/`:
- Override origin host: `<YOUR_RAILWAY_HOST>` (example: `your-app.up.railway.app`)
- Forward HTTPS

### Rule B (Frontend)
If path starts with `/grantflow/`:
- Override origin host: `<YOUR_VERCEL_HOST>` (example: `your-app.vercel.app`)
- Forward HTTPS

## 4) Verify
- `GET https://www.axiombiolabs.org/api/anya/status`
- `GET https://www.axiombiolabs.org/api/opportunities`
- `GET https://www.axiombiolabs.org/grantflow/`
