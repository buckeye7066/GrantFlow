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



### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
# Start development server
npm run dev
```

The site will be available at `http://localhost:5173/`

### Build for Production

```bash
# Build optimized production bundle
npm run build
```

The production files will be in the `dist/` directory.

### Preview Production Build

```bash
# Preview production build locally
npm run preview
```

### Linting

```bash
# Run ESLint
npm run lint
```

## Deployment

### GoDaddy Hosting

1. **Build the project:**
   ```bash
   npm run build
   ```

2. **Upload to GoDaddy:**
   - Log in to your GoDaddy account
   - Navigate to your hosting control panel (cPanel)
   - Use File Manager or FTP to upload the contents of the `dist/` folder
   - Upload to your `public_html` directory (or subdirectory)
   - Ensure the `index.html` is in the root of your web directory

3. **Configure .htaccess for Single Page Application:**
   Create a `.htaccess` file in your web root with:
   ```apache
   <IfModule mod_rewrite.c>
     RewriteEngine On
     RewriteBase /
     RewriteRule ^index\.html$ - [L]
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule . /index.html [L]
   </IfModule>
   ```

### Cloudflare Setup

1. **Add Site to Cloudflare:**
   - Log in to Cloudflare
   - Add your domain
   - Update nameservers at GoDaddy to Cloudflare's nameservers

2. **Configure Caching Rules:**
   - Go to Caching > Configuration
   - Set Browser Cache TTL to "Respect Existing Headers"
   - Enable "Always Online"

3. **Page Rules for SPA:**
   - Create a page rule for `yourdomain.com/*`
   - Set Cache Level to "Cache Everything"
   - Edge Cache TTL: 1 month
   - Browser Cache TTL: 4 hours

4. **Purge Cache After Updates:**
   - Go to Caching > Configuration
   - Click "Purge Everything" after deploying new versions
   - Or use Cloudflare API for automated cache purging

5. **Performance Optimizations:**
   - Enable Auto Minify (JavaScript, CSS, HTML)
   - Enable Brotli compression
   - Enable HTTP/2 and HTTP/3

6. **Security Settings:**
   - Enable "Always Use HTTPS"
   - Set SSL/TLS encryption mode to "Full" or "Full (strict)"
   - Enable "Automatic HTTPS Rewrites"

## Project Structure

```
GrantFlow/
├── src/
│   ├── components/
│   │   ├── Navigation.jsx    # Main navigation bar
│   │   └── Footer.jsx         # Site footer
│   ├── pages/
│   │   ├── Home.jsx           # Landing page
│   │   ├── Pricing.jsx        # Pricing plans
│   │   ├── Terms.jsx          # Terms of Service
│   │   ├── Privacy.jsx        # Privacy Policy
│   │   ├── HIPAA.jsx          # HIPAA Compliance
│   │   └── DataRetention.jsx  # Data Retention Policy
│   ├── App.jsx                # Main app component with routing
│   ├── main.jsx               # Application entry point
│   └── index.css              # Global styles with Tailwind
├── public/                    # Static assets
├── index.html                 # HTML template
├── tailwind.config.js         # Tailwind configuration
├── postcss.config.js          # PostCSS configuration
├── vite.config.js             # Vite configuration
└── package.json               # Project dependencies
```

## Placeholder Assets

⚠️ **Note: The following assets need to be replaced with actual assets:**

- Company logo (currently using text-based branding)
- Hero section background images
- Feature icons (currently using emoji placeholders: 🔍 📊 🔒)
- Testimonial photos
- Any branded imagery

To add real images:
1. Place images in the `public/` directory
2. Reference them in components using `/image-name.png`
3. For optimized images, place in `src/assets/` and import in components

## Customization

### Brand Colors

Edit `tailwind.config.js` to update brand colors:

```javascript
theme: {
  extend: {
    colors: {
      'axiom-blue': '#1e40af',        // Primary brand color
      'axiom-light-blue': '#3b82f6',  // Secondary brand color
    },
  },
}
```

### Content Updates

- **Home page:** Edit `src/pages/Home.jsx`
- **Pricing:** Edit `src/pages/Pricing.jsx`
- **Legal pages:** Edit respective files in `src/pages/`
- **Navigation links:** Edit `src/components/Navigation.jsx`
- **Footer content:** Edit `src/components/Footer.jsx`

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## License

Copyright © 2024 Axiom BioLabs. All rights reserved.

## Support

For questions or issues, contact: support@axiombiolabs.org
A grant management application built with React, TypeScript, and Vite.

## 🚀 Quick Start

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

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
   
   # Edit .env and replace placeholder values with your actual configuration
   # IMPORTANT: Never commit your .env file to version control
   ```

4. **Start the development servers**
   
   **Frontend (Vite dev server):**
   ```bash
   npm run dev
   ```
   
   **Backend (if applicable):**
   ```bash
   cd backend
   npm start
   ```

## 🔐 Environment Configuration

### Required Environment Variables

GrantFlow requires several environment variables to run properly. These should be configured in a `.env` file in the root directory.

#### Backend Variables
- `ANYA_ADMIN_TOKEN` - Admin authentication token (⚠️ **Must be a strong, random value**)
- `PORT` - Backend server port (default: 4000)
- `CORS_ORIGIN` - Allowed CORS origin for API requests

#### Frontend Variables
- `VITE_API_PROXY_TARGET` - Backend API URL for Vite proxy

#### Optional Variables
- `OPENAI_API_KEY` - For AI-powered features (if enabled)
- Database connection strings (if using a database)

### 🔒 Security Best Practices

**CRITICAL:** Never commit secrets to version control!

1. **Always use `.env` for local development**
   - Your `.env` file is automatically ignored by git
   - Use `.env.example` as a template (safe to commit)

2. **Generate strong tokens**
   ```bash
   # Example: Generate a secure random token
   openssl rand -hex 32
   ```

3. **Rotate exposed secrets immediately**
   - If you accidentally expose an API key, rotate it immediately
   - Check your git history for accidentally committed secrets
   - Review access logs for unauthorized usage

4. **Use different secrets for each environment**
   - Development, staging, and production should have unique credentials

5. **Audit your configuration regularly**
   ```bash
   # Check that .env is in .gitignore
   git check-ignore .env
   
   # Search for accidentally committed secrets (if you have git-secrets)
   git secrets --scan
   ```

### 📋 Environment Setup Checklist

- [ ] `.env` file created from `.env.example`
- [ ] All placeholder values replaced with real credentials
- [ ] Strong, random token generated for `ANYA_ADMIN_TOKEN`
- [ ] Verified `.env` is in `.gitignore`
- [ ] Confirmed no secrets in git history
- [ ] Different credentials for dev/staging/production

## 🛠️ Development

### Tech Stack

- **Frontend:** React + TypeScript + Vite
- **Styling:** Tailwind CSS
- **Backend:** Node.js (Express)
- **Build Tool:** Vite with HMR (Hot Module Replacement)

### Available Scripts

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run linter
npm run lint
```

## 📦 Building for Production

```bash
# Create optimized production build
npm run build

# The build output will be in the `dist` directory
```

**Before deploying:**
- Ensure all environment variables are properly configured on your hosting platform
- Use production-grade secrets (not development values)
- Enable HTTPS for all production deployments
- Set appropriate CORS origins

## 🚀 Production Deployment

For deploying GrantFlow to a production environment (Digital Ocean, AWS, etc.), see the comprehensive deployment guide:

**[📘 Production Deployment Guide](docs/DEPLOYMENT.md)**

The deployment guide covers:
- Digital Ocean server setup
- Cloudflare and DNS configuration
- Nginx reverse proxy configuration
- SSL/TLS certificate setup
- Backend service configuration with systemd
- Automated deployment scripts
- Troubleshooting common issues
- Health checks and monitoring

### Quick Deploy

For automated deployment on your production server:

```bash
# Make the deployment script executable
chmod +x scripts/deploy-production.sh

# Run the deployment
./scripts/deploy-production.sh
```

### Production Checklist

Before going live, ensure:
- [ ] Environment variables configured (`.env.production.example` → `.env`)
- [ ] Strong, random `ANYA_ADMIN_TOKEN` generated
- [ ] CORS origins set to production domain(s)
- [ ] SSL/TLS certificates installed
- [ ] Nginx configured and running
- [ ] Backend systemd service enabled
- [ ] Firewall rules configured (ports 80, 443, 22)
- [ ] DNS records pointing to your server
- [ ] Health checks passing

### Production Architecture

```
GoDaddy Domain → Cloudflare CDN → Digital Ocean Server
                                           ↓
                                    Nginx (Reverse Proxy)
                                    ├── /grantflow/* → Frontend (Static)
                                    └── /grantflow/api/* → Backend (:4000)
```

## 🧪 React + Vite Configuration

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc/tree/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

### Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      // Or for stricter rules:
      // tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
])
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**Security Note:** Never include secrets or API keys in your commits!

## 📄 License

This project is licensed under the MIT License.

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
- Check for TypeScript errors: `npm run type-check` (if configured)

## 🔗 Resources

- [Vite Documentation](https://vitejs.dev/)
- [React Documentation](https://react.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
