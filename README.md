# GrantFlow

A professional marketing website for GrantFlow by Axiom BioLabs - Finding funding sources for various financial situations.

## Overview

This is a static marketing site built with Vite, React, and Tailwind CSS. It includes:

- Landing page with hero section, features, and CTAs
- Pricing page with multiple subscription tiers
- Complete legal pages (Terms of Service, Privacy Policy, HIPAA Compliance, Data Retention)
- Responsive design with modern UI components
- Navigation and footer with all required links

## Technology Stack

- **Vite** - Fast build tool and dev server
- **React** - UI component library
- **Tailwind CSS** - Utility-first CSS framework
- **React Router** - Client-side routing

## Getting Started

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
