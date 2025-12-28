#!/bin/bash
set -e

echo "🚀 Starting GrantFlow production deployment..."

# Ensure we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: Must run from GrantFlow root directory"
  exit 1
fi

# Backup if exists
if [ -d "dist" ]; then
  mv dist dist.backup.$(date +%s)
fi

# Install and build
echo "📦 Installing dependencies..."
npm ci

echo "🏗️ Building frontend..."
npm run build

# Deploy frontend files
echo "📁 Deploying frontend files..."
mkdir -p /var/www/html/grantflow
cp -r dist/* /var/www/html/grantflow/
chown -R www-data:www-data /var/www/html/grantflow
chmod -R 755 /var/www/html/grantflow

# Nginx setup
if [ -f "nginx/grantflow.conf" ]; then
  echo "⚙️ Configuring nginx..."
  cp nginx/grantflow.conf /etc/nginx/sites-available/grantflow
  ln -sf /etc/nginx/sites-available/grantflow /etc/nginx/sites-enabled/
  nginx -t
  systemctl reload nginx
fi

# Systemd setup
if [ -f "systemd/grantflow-backend.service" ]; then
  echo "⚙️ Configuring systemd service..."
  cp systemd/grantflow-backend.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable grantflow-backend
  systemctl restart grantflow-backend
fi

# Health check
echo "🏥 Running health check..."
sleep 3
if curl -f http://localhost:4000/api/health; then
  echo "✅ Backend is healthy!"
else
  echo "❌ Backend health check failed"
  exit 1
fi

echo "✅ Deployment complete!"
echo "🌐 Visit: https://app.axiombiolabs.org/grantflow/login"

