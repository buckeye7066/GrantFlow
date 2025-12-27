# GrantFlow

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