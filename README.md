# GrantFlow

A grant lifecycle management platform by Axiom BioLabs - Streamlining grant discovery, application, and tracking for organizations and individuals.

## Overview

GrantFlow is currently a **marketing site + backend foundation** with plans to evolve into a full-featured grant management application. The platform includes:

**Current Features:**
- Marketing website with landing page, pricing, and legal pages
- Basic grant operations dashboard
- Organization/profile management
- Document upload and processing pipeline
- Grant opportunity database
- RESTful backend APIs
- AI integration foundation (Anya runtime)

**Target State:**
The full-featured GrantFlow will provide complete grant lifecycle management with AI-powered features, similar to the [Base44 reference implementation](https://grant-flow-736bafec.base44.app).

See [Feature Roadmap](#feature-roadmap) below for details on current capabilities and planned features.

## Technology Stack

**Frontend:**
- **React 19** + **TypeScript** - Modern UI framework
- **Vite 7** - Fast build tool and dev server with HMR
- **Tailwind CSS 4** - Utility-first CSS framework
- **React Router 7** - Client-side routing
- **React Query 5** - Server state management

**Backend:**
- **Node.js** + **Express** - RESTful API server
- **SQLite** (better-sqlite3) - Database with WAL mode
- **Anya Runtime** - AI integration foundation
- **OpenAI API** - AI-powered features (configured)

## Feature Roadmap

GrantFlow is evolving from a marketing site + backend foundation into a comprehensive grant lifecycle management platform. Our target is feature parity with the [Base44 reference implementation](https://grant-flow-736bafec.base44.app).

### Current Implementation (Phase 1) ✅

**Marketing & Documentation:**
- Professional marketing website with pricing and legal pages
- Comprehensive deployment and configuration documentation

**Backend Foundation:**
- RESTful APIs for profiles, documents, and opportunities
- SQLite database with profiles, documents, and funding_sources tables
- Document upload, parsing, and data extraction pipeline
- Admin authentication with token-based security
- AI integration foundation (Anya runtime)
- Railway deployment with health monitoring

**Basic Application UI:**
- Grant operations dashboard with key metrics
- Organization management (create, edit, list)
- Document upload interface
- Anya AI status panel

### Planned Features (Phases 2-6)

**Phase 2: Pipeline Management** 🚧 *Next Priority*
- Full grant lifecycle tracking (discovered → awarded)
- Kanban board with drag-and-drop
- Grant detail pages with milestones and expenses
- Activity logging and audit trail

**Phase 3: Proposal Drafting** 📋
- Rich text proposal editor
- AI-assisted content generation
- Template library
- Version control and collaboration

**Phase 4: Analytics & Reporting** 📊
- Success rate analytics
- Pipeline funnel visualization
- Custom report builder
- Export to PDF/CSV

**Phase 5: Submission Tracking** 📤
- Submission checklists
- Document requirement tracking
- Follow-up activity management
- Deadline notifications

**Phase 6: User Management & RBAC** 🔐
- Multi-user authentication
- Role-based access control
- Team collaboration
- Permission management

### Documentation

For detailed information about current capabilities, missing features, and the development roadmap:

- **[Feature Parity Analysis](docs/FEATURE_PARITY.md)** - Complete comparison with Base44 reference implementation
- **[Development Roadmap](docs/DEVELOPMENT_ROADMAP.md)** - Phased implementation plan with technical details
- **[Backend Documentation](backend/README.md)** - API endpoints, database schema, and AI integration
- **[UI Architecture](docs/UI_ARCHITECTURE.md)** - Component design and frontend architecture


AI-powered grant discovery and application management platform by Axiom BioLabs - Finding funding sources for various financial situations.

## 🎯 Overview

GrantFlow is a comprehensive grant management application that helps individuals and organizations discover funding opportunities, manage applications, and increase their success rate through intelligent automation and AI-powered guidance.

**Key Features:**
- 🔍 Advanced grant search and discovery
- 🤖 ANYA AI assistant for grant guidance
- 📄 Intelligent document processing and analysis
- 📊 Application tracking and milestone management
- 💰 Expense tracking and reporting
- 🎯 Personalized grant recommendations

## 🏗️ Technology Stack

### Frontend
- **Framework:** React 19.2.0 with TypeScript 5.9.3
- **Build Tool:** Vite 7.2.4 (fast HMR and optimized builds)
- **Styling:** Tailwind CSS 4.1.18 (utility-first CSS)
- **Routing:** React Router DOM 7.11.0
- **State Management:** TanStack Query 5.62.7
- **Icons:** Lucide React 0.470.0

### Backend
- **Runtime:** Node.js 18+
- **Framework:** Express.js 4.19.2
- **Database:** SQLite 3 (better-sqlite3 11.8.1)
- **Document Processing:** pdf-parse, mammoth, tesseract.js
- **AI Integration:** OpenAI API
- **Authentication:** Token-based (JWT planned for Phase 1)

### Infrastructure
- **Frontend Hosting:** Vercel (recommended)
- **Backend Hosting:** Railway (recommended)
- **CDN & DNS:** Cloudflare
- **Legacy Option:** Digital Ocean with Nginx (see legacy docs)

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/buckeye7066/GrantFlow.git
   cd GrantFlow
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   # Copy the example environment file
   cp .env.example .env
   
   # Edit .env and configure your values
   # See "Environment Configuration" section below
   ```

4. **Start the development servers**
   
   **Option 1: Full stack (frontend + backend)**
   ```bash
   npm run dev:full
   ```
   
   **Option 2: Frontend only**
   ```bash
   npm run dev
   ```
   
   **Option 3: Backend only**
   ```bash
   npm run backend
   ```

The frontend will be available at `http://localhost:5173/`
The backend API will be available at `http://localhost:8080/`

## 🚀 Production Deployment

### Recommended: Vercel + Railway Architecture

For modern, scalable production deployments, we recommend:

**Frontend:** Vercel (optimized for React/Vite apps)
**Backend:** Railway (modern backend hosting)
**CDN/DNS:** Cloudflare (free tier available)

📖 **Complete Migration Guide:** [`docs/DNS_MIGRATION.md`](docs/DNS_MIGRATION.md)
📋 **Pre-flight Checklist:** [`docs/VERCEL_DOMAIN_CHECKLIST.md`](docs/VERCEL_DOMAIN_CHECKLIST.md)
🚀 **Quick Reference:** [`DEPLOYMENT_PATH2.md`](DEPLOYMENT_PATH2.md)

**Benefits:**
- ✅ Zero server maintenance
- ✅ Automatic SSL/HTTPS
- ✅ Global CDN distribution
- ✅ Auto-scaling
- ✅ Easy rollbacks
- ✅ Built-in monitoring
- ✅ Cost-effective (pay only for usage)

### Architecture Overview

```
GoDaddy Domain (axiombiolabs.org)
           ↓
   Cloudflare DNS + CDN
           ↓
   Origin Rules (Path-based routing)
   ├── /grantflow/* → Vercel (Frontend Static Files)
   └── /api/* → Railway (Backend API)
```

### Legacy: Digital Ocean Deployment

For self-hosted deployments on Digital Ocean with Nginx:

⚠️ **LEGACY OPTION**: This deployment method is no longer recommended for new deployments.

📖 **Legacy Guide:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

### Production Checklist

Before going live:
- [ ] Environment variables configured for production
- [ ] Strong, random `ANYA_ADMIN_TOKEN` generated (`openssl rand -hex 32`)
- [ ] CORS origins set to production domain(s)
- [ ] SSL/TLS certificates configured
- [ ] DNS records configured in Cloudflare
- [ ] Cloudflare Origin Rules set up
- [ ] Health checks passing
- [ ] Monitoring and alerting configured

## 🗺️ Feature Roadmap

GrantFlow is actively under development with a phased approach to reach full feature parity with enterprise grant management platforms.

### Current Status (v0.1 - Foundation)

**✅ Completed:**
- Basic React frontend with modern UI components
- Express backend API framework  
- SQLite database with grant schema
- Document parser infrastructure (PDF, DOCX, OCR)
- ANYA AI chat interface
- Authentication stub (admin token)
- Railway + Vercel deployment configuration

**📊 Feature Parity:** ~27% complete (see [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md))

### Development Phases

#### Phase 1: User Foundation (Weeks 1-6)
- [ ] User registration and authentication (JWT)
- [ ] User profile management
- [ ] Advanced grant search and filtering
- [ ] Bookmark and basic tracking

**Goal:** Users can search, discover, and track grants

#### Phase 2: Core Grant Management (Weeks 7-12)
- [ ] Application status tracking workflow
- [ ] Email notification system
- [ ] Deadline reminders
- [ ] Personal dashboard with real metrics

**Goal:** Users can manage entire grant application lifecycle

#### Phase 3: Intelligence & Automation (Weeks 13-20)
- [ ] Enhanced ANYA with grant-specific knowledge
- [ ] Grant recommendation engine
- [ ] Eligibility matching system
- [ ] Advanced document extraction

**Goal:** AI-powered assistance throughout process

#### Phase 4: External Integrations (Weeks 21-28)
- [ ] Grants.gov API integration
- [ ] Foundation database connections
- [ ] Local government grant crawlers
- [ ] Unified grant ingestion pipeline

**Goal:** Comprehensive grant database from multiple sources

#### Phase 5: Application Workflow (Weeks 29-36)
- [ ] Document library and management
- [ ] Application form builder
- [ ] Pre-fill from user profile
- [ ] Application submission tracking

**Goal:** Complete application lifecycle management

#### Phase 6: Analytics & Premium (Weeks 37-44)
- [ ] Enhanced dashboard and reporting
- [ ] Subscription tiers (Free, Pro, Team)
- [ ] Payment integration (Stripe)
- [ ] Team collaboration features

**Goal:** Production-ready, revenue-generating product

#### Phase 7: Production Hardening (Weeks 45-48)
- [ ] Comprehensive monitoring (Sentry, logging)
- [ ] Automated backups and disaster recovery
- [ ] Security hardening (OWASP compliance)
- [ ] Complete API documentation

**Goal:** Enterprise-grade reliability and security

### Detailed Documentation

📖 **Feature Comparison:** [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md)
🗓️ **Development Timeline:** [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md)
🎨 **UI Architecture:** [`docs/UI_ARCHITECTURE.md`](docs/UI_ARCHITECTURE.md)
📡 **Backend API:** [`backend/README.md`](backend/README.md)

### Target: v1.0 Production Release

**Timeline:** 48 weeks (1 year from start)
**Feature Parity:** 95%+ complete
**Status:** Production-ready, publicly launchable

## 📁 Project Structure

```
GrantFlow/
├── backend/                    # Backend API server
│   ├── anya/                  # ANYA AI assistant
│   ├── audit/                 # Audit logging
│   ├── crawlers/              # Grant data crawlers
│   ├── data/                  # Database and data files
│   ├── db/                    # Database schema and utilities
│   ├── middleware/            # Express middleware
│   ├── parser/                # Document processing
│   │   ├── text/             # PDF, DOCX, OCR parsers
│   │   └── extract/          # Field extraction logic
│   ├── routes/                # API route handlers
│   ├── services/              # Business logic services
│   ├── storage/               # File storage utilities
│   └── server.js              # Backend entry point
├── docs/                      # Documentation
│   ├── DNS_MIGRATION.md       # Vercel + Railway migration guide
│   ├── VERCEL_DOMAIN_CHECKLIST.md  # Pre-migration checklist
│   ├── FEATURE_PARITY.md      # Feature comparison analysis
│   ├── DEVELOPMENT_ROADMAP.md # Phased development plan
│   ├── UI_ARCHITECTURE.md     # Frontend architecture guide
│   ├── DEPLOYMENT.md          # Legacy Digital Ocean guide
│   └── GITHUB_SECRETS.md      # GitHub secrets configuration
├── src/                       # Frontend application
│   ├── components/            # React components
│   │   ├── common/           # Reusable UI components
│   │   ├── layout/           # Layout components
│   │   └── grants/           # Grant-specific components
│   ├── pages/                 # Page-level components
│   ├── hooks/                 # Custom React hooks
│   ├── contexts/              # React Context providers
│   ├── api/                   # API client utilities
│   ├── utils/                 # Utility functions
│   ├── App.jsx                # Root component with routing
│   └── main.jsx               # Application entry point
├── public/                    # Static assets
├── scripts/                   # Build and deployment scripts
├── nginx/                     # Nginx configuration (legacy)
├── systemd/                   # Systemd service files (legacy)
├── .env.example               # Environment variables template
├── DEPLOYMENT_PATH2.md        # Vercel + Railway quick reference
├── package.json               # Dependencies and scripts
├── vite.config.ts             # Vite configuration
└── tailwind.config.js         # Tailwind CSS configuration
```

## 🛠️ Development

### Available Scripts

```bash
# Start frontend development server
npm run dev

# Start backend server
npm run backend

# Start both frontend and backend
npm run dev:full

# Build frontend for production
npm run build

# Preview production build
npm run preview

# Run linter
npm run lint
```

## 🔐 Environment Configuration

### Required Environment Variables

#### Backend Variables
```env
ANYA_ADMIN_TOKEN=<secure-random-token>  # Generate with: openssl rand -hex 32
PORT=8080                                # Backend server port
CORS_ORIGIN=http://localhost:5173       # Frontend URL for CORS
NODE_ENV=development                     # Environment
```

**Before deploying:**
- Ensure all environment variables are properly configured on your hosting platform
- Use production-grade secrets (not development values)
- Enable HTTPS for all production deployments
- Set appropriate CORS origins

## 🚀 Production Deployment

### Current Production Stack (Recommended)

GrantFlow uses a modern serverless architecture:

**Primary Deployment Method: Vercel + Railway**

```
GoDaddy/Cloudflare DNS → Vercel (Frontend) → Railway (Backend)
                              ↓
                         /grantflow/* → React App
                         /api/* → Node.js API
```

**Architecture:**
- **Frontend:** Vercel (Static site with edge caching)
- **Backend:** Railway (Node.js API service)
- **CDN:** Vercel Edge Network
- **Base Path:** `/grantflow/`

**Current Status:**
- ✅ Working at `app.axiombiolabs.org/grantflow`
- ⏳ DNS migration pending for root domain

### Deployment Guides

📘 **[Vercel + Railway Deployment](DEPLOYMENT_PATH2.md)** - Current deployment architecture

📘 **[DNS Migration Guide](docs/DNS_MIGRATION.md)** - Complete root domain migration to Vercel:
- Step-by-step Vercel domain configuration
- DNS setup for GoDaddy and Cloudflare
- CORS configuration for Railway backend
- Testing and verification procedures

✅ **[Domain Migration Checklist](docs/VERCEL_DOMAIN_CHECKLIST.md)** - Pre-flight checklist:
- Pre-migration verification
- Execution steps
- Post-migration smoke tests
- Rollback procedures

### Production Checklist (Vercel + Railway)

Before going live:
- [ ] Vercel project deployed and verified
- [ ] Railway backend service running
- [ ] Environment variables configured on Railway
- [ ] `CORS_ORIGIN` includes all domains
- [ ] Custom domains added in Vercel
- [ ] DNS records configured (see DNS Migration Guide)
- [ ] SSL certificates verified in Vercel
- [ ] Health checks passing on Railway
- [ ] End-to-end authentication tested

### Quick Verification

```bash
# Test frontend
curl -I https://app.axiombiolabs.org/grantflow/login

# Test backend API
curl https://grantflow-production.up.railway.app/api/health

# Expected: {"status":"ok"}
```

---

## Legacy Deployment (Digital Ocean)

> **⚠️ DEPRECATED:** The Digital Ocean deployment method is being phased out in favor of Vercel + Railway.

**[📘 Legacy Deployment Guide](docs/DEPLOYMENT.md)** (Digital Ocean + Nginx)

The legacy guide covers:
- Digital Ocean server setup
- Cloudflare and DNS configuration
- Nginx reverse proxy configuration
- SSL/TLS certificate setup
- Backend service configuration with systemd
- Troubleshooting common issues

### Legacy Architecture
#### Optional Variables
```env
OPENAI_API_KEY=<your-api-key>           # For AI features
DATABASE_URL=./backend/data/grantflow.db # Database path
```

### 🔒 Security Best Practices

**CRITICAL:** Never commit secrets to version control!

1. **Always use `.env` for local development**
   - Your `.env` file is automatically ignored by git
   - Use `.env.example` as a template

2. **Generate strong tokens**
   ```bash
   # Generate a secure random token
   openssl rand -hex 32
   ```

3. **Use different secrets for each environment**
   - Development, staging, and production should have unique credentials

4. **Environment Setup Checklist**
   - [ ] `.env` file created from `.env.example`
   - [ ] All placeholder values replaced
   - [ ] Strong token generated for `ANYA_ADMIN_TOKEN`
   - [ ] Verified `.env` is in `.gitignore`
   - [ ] Different credentials for dev/staging/production

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**Security Note:** Never include secrets or API keys in your commits!

## 🆘 Troubleshooting

### Common Issues

**Environment variables not loading:**
- Verify `.env` file exists in project root
- Check that variables are properly formatted (`KEY=value`)
- Restart development server after changing `.env`

**CORS errors:**
- Check `CORS_ORIGIN` matches your frontend URL
- Verify backend server is running on the correct port

**Build failures:**
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`
- Check for TypeScript errors with build

**Backend not starting:**
- Verify all required environment variables are set
- Check backend logs for error messages
- Ensure port 8080 is available

## 📚 Documentation

- [`README.md`](README.md) - This file (project overview)
- [`backend/README.md`](backend/README.md) - Backend API documentation
- [`docs/DNS_MIGRATION.md`](docs/DNS_MIGRATION.md) - Vercel + Railway deployment
- [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md) - Feature comparison
- [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md) - Development plan
- [`docs/UI_ARCHITECTURE.md`](docs/UI_ARCHITECTURE.md) - Frontend architecture
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) - Legacy deployment guide

## 🔗 Resources

- [Vite Documentation](https://vitejs.dev/)
- [React Documentation](https://react.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [Tailwind CSS Documentation](https://tailwindcss.com/)
- [Express.js Documentation](https://expressjs.com/)

## 📄 License

Copyright © 2024 Axiom BioLabs. All rights reserved.

## 🆘 Support

For questions or issues:
- **GitHub Issues:** https://github.com/buckeye7066/GrantFlow/issues
- **Email:** support@axiombiolabs.org

---

**Built with ❤️ by Axiom BioLabs**
