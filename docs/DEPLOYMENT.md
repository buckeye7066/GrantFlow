# Production Deployment Guide

GrantFlow is deployed using modern cloud services for optimal performance and reliability:

- **Frontend**: Vercel (serves `/grantflow`)
- **Backend**: Railway (Node/Express + SQLite)

## Full Deployment Instructions

See [`VERCEL_RAILWAY_DEPLOYMENT.md`](VERCEL_RAILWAY_DEPLOYMENT.md) for complete step-by-step deployment instructions, including:

- Environment variable configuration
- Build and deployment commands
- Database seeding
- Health checks and monitoring
- Troubleshooting

## Quick Links

- [Vercel Dashboard](https://vercel.com/dashboard)
- [Railway Dashboard](https://railway.app/dashboard)
- [Production Readiness (Reality Report)](PROD_READINESS.md)

---

**Note**: Self-hosted deployment options (DigitalOcean, AWS EC2, etc.) are no longer maintained. Use the Vercel + Railway stack for the best experience.
