# Production Deployment Guide

This guide provides step-by-step instructions for deploying GrantFlow to a Digital Ocean droplet with Nginx, behind Cloudflare CDN, using a GoDaddy domain.

## Architecture Overview

```
GoDaddy Domain (axiombiolabs.org)
           ↓
   Cloudflare CDN (SSL/CDN)
           ↓
Digital Ocean Droplet (Ubuntu/Debian)
           ↓
    Nginx (Reverse Proxy)
    ├── /grantflow/* → Static Files (/var/www/html/grantflow/)
    └── /grantflow/api/* → Backend (localhost:4000)
```

## Prerequisites

- Digital Ocean droplet running Ubuntu 20.04+ or Debian 11+
- Root or sudo access to the server
- Domain configured in GoDaddy and Cloudflare
- Node.js 16+ installed on the server
- Nginx installed on the server

## Table of Contents

1. [Server Setup](#server-setup)
2. [DNS Configuration](#dns-configuration)
3. [Cloudflare Configuration](#cloudflare-configuration)
4. [SSL Certificate Setup](#ssl-certificate-setup)
5. [Backend Deployment](#backend-deployment)
6. [Frontend Deployment](#frontend-deployment)
7. [Nginx Configuration](#nginx-configuration)
8. [Health Checks](#health-checks)
9. [Troubleshooting](#troubleshooting)
10. [Maintenance](#maintenance)

---

## 1. Server Setup

### Initial Server Preparation

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y nginx nodejs npm git curl certbot python3-certbot-nginx

# Verify installations
nginx -v
node -v
npm -v
```

### Create Application User

```bash
# Create a dedicated user for the application
sudo useradd -r -m -s /bin/bash grantflow
sudo usermod -aG sudo grantflow
```

### Firewall Configuration

```bash
# Configure UFW firewall
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

---

## 2. DNS Configuration

### GoDaddy DNS Settings

Configure the following DNS records in your GoDaddy domain management:

**Option 1: Using Cloudflare Nameservers (Recommended)**

1. Log in to GoDaddy
2. Navigate to DNS Management for `axiombiolabs.org`
3. Update nameservers to Cloudflare's nameservers:
   ```
   NS1: abe.ns.cloudflare.com
   NS2: joy.ns.cloudflare.com
   ```
   (Use the nameservers provided by Cloudflare)

**Option 2: Using CNAME/A Records (Alternative)**

If keeping GoDaddy nameservers:

| Type  | Name | Value                | TTL  |
|-------|------|----------------------|------|
| A     | app  | YOUR_DROPLET_IP      | 600  |
| CNAME | www  | app.axiombiolabs.org | 3600 |

---

## 3. Cloudflare Configuration

### Add Site to Cloudflare

1. **Add Site:**
   - Log in to Cloudflare
   - Click "Add a site"
   - Enter `axiombiolabs.org`
   - Select Free plan

2. **DNS Records:**
   Add the following DNS records in Cloudflare:
   
   | Type | Name | Content         | Proxy Status | TTL  |
   |------|------|-----------------|--------------|------|
   | A    | app  | YOUR_DROPLET_IP | Proxied      | Auto |
   | A    | www  | YOUR_DROPLET_IP | Proxied      | Auto |

3. **SSL/TLS Settings:**
   - Go to SSL/TLS → Overview
   - Select **"Full"** or **"Full (strict)"** encryption mode
   - Enable "Always Use HTTPS"

4. **Additional Settings:**
   - **Speed → Auto Minify:** Enable HTML, CSS, JS
   - **Security → Security Level:** Medium
   - **Network → HTTP/2:** Enabled
   - **Edge Certificates → Always Use HTTPS:** Enabled

---

## 4. SSL Certificate Setup

### Option 1: Cloudflare SSL (Recommended)

When using Cloudflare proxy (orange cloud), Cloudflare handles SSL termination. You still need a certificate on your origin server:

```bash
# Install Cloudflare Origin Certificate
sudo mkdir -p /etc/nginx/ssl

# Create origin certificate in Cloudflare dashboard:
# SSL/TLS → Origin Server → Create Certificate
# Save the certificate and key to:
sudo nano /etc/nginx/ssl/cloudflare-origin.crt
sudo nano /etc/nginx/ssl/cloudflare-origin.key

# Set proper permissions
sudo chmod 600 /etc/nginx/ssl/cloudflare-origin.key
sudo chmod 644 /etc/nginx/ssl/cloudflare-origin.crt
```

### Option 2: Let's Encrypt (Alternative)

If not using Cloudflare proxy:

```bash
# Obtain Let's Encrypt certificate
sudo certbot --nginx -d app.axiombiolabs.org -d www.axiombiolabs.org

# Auto-renewal is handled by certbot timer
sudo systemctl status certbot.timer
```

---

## 5. Backend Deployment

### Clone Repository

```bash
# Clone the repository
sudo mkdir -p /opt/grantflow
sudo chown grantflow:grantflow /opt/grantflow
sudo su - grantflow
cd /opt/grantflow
git clone https://github.com/buckeye7066/GrantFlow.git .
```

### Install Dependencies

```bash
# Install Node.js dependencies
npm install --production
```

### Configure Environment

```bash
# Create production environment file
cp .env.production.example .env

# Edit the .env file with production values
nano .env
```

Required environment variables:
```env
ANYA_ADMIN_TOKEN=<generate-secure-random-token>
PORT=4000
CORS_ORIGIN=https://app.axiombiolabs.org,https://www.axiombiolabs.org
OPENAI_API_KEY=<your-openai-api-key>
NODE_ENV=production
```

Generate secure token:
```bash
openssl rand -hex 32
```

### Create Systemd Service

```bash
# Copy systemd service file
sudo cp /opt/grantflow/systemd/grantflow-backend.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable grantflow-backend
sudo systemctl start grantflow-backend

# Check status
sudo systemctl status grantflow-backend
```

### Verify Backend

```bash
# Test health endpoint
curl http://localhost:4000/api/health

# Expected output: {"status":"ok","timestamp":"..."}
```

---

## 6. Frontend Deployment

### Build Frontend

```bash
# Build the production frontend
cd /opt/grantflow
npm run build

# The build output will be in the dist/ directory
```

### Deploy Static Files

```bash
# Create web root directory
sudo mkdir -p /var/www/html/grantflow

# Copy built files
sudo cp -r /opt/grantflow/dist/* /var/www/html/grantflow/

# Set proper permissions
sudo chown -R www-data:www-data /var/www/html/grantflow
sudo chmod -R 755 /var/www/html/grantflow
```

---

## 7. Nginx Configuration

### Configure Nginx

```bash
# Copy nginx configuration
sudo cp /opt/grantflow/nginx/grantflow.conf /etc/nginx/sites-available/

# Create symbolic link
sudo ln -s /etc/nginx/sites-available/grantflow.conf /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# If test passes, reload nginx
sudo systemctl reload nginx
```

### Verify Nginx

```bash
# Check nginx status
sudo systemctl status nginx

# View nginx error logs if issues occur
sudo tail -f /var/log/nginx/error.log
```

---

## 8. Health Checks

### Backend Health Check

```bash
# Local check
curl http://localhost:4000/api/health

# External check (through nginx)
curl https://app.axiombiolabs.org/grantflow/api/health
```

### Frontend Check

```bash
# Check if frontend is accessible
curl -I https://app.axiombiolabs.org/grantflow/

# Should return 200 OK
```

### Monitor Services

```bash
# Check backend service
sudo systemctl status grantflow-backend

# View backend logs
sudo journalctl -u grantflow-backend -f

# Check nginx
sudo systemctl status nginx

# View nginx access logs
sudo tail -f /var/log/nginx/access.log
```

---

## 9. Troubleshooting

### 500 Internal Server Error

**Symptom:** Browser shows 500 error when accessing the site

**Possible Causes & Solutions:**

1. **Frontend files not deployed:**
   ```bash
   # Verify files exist
   ls -la /var/www/html/grantflow/
   
   # Should see index.html, assets/, etc.
   # If missing, rebuild and redeploy
   cd /opt/grantflow
   npm run build
   sudo cp -r dist/* /var/www/html/grantflow/
   ```

2. **Nginx configuration error:**
   ```bash
   # Test nginx config
   sudo nginx -t
   
   # View error logs
   sudo tail -50 /var/log/nginx/error.log
   
   # Common issues:
   # - Wrong root path
   # - Missing try_files directive
   # - Incorrect proxy_pass URL
   ```

3. **Backend not running:**
   ```bash
   # Check service status
   sudo systemctl status grantflow-backend
   
   # If not running, start it
   sudo systemctl start grantflow-backend
   
   # View logs
   sudo journalctl -u grantflow-backend -n 100
   ```

4. **Permission issues:**
   ```bash
   # Fix file permissions
   sudo chown -R www-data:www-data /var/www/html/grantflow
   sudo chmod -R 755 /var/www/html/grantflow
   ```

### Favicon 404/500 Error

**Solution:**
```bash
# Ensure favicon is in the correct location
ls -la /var/www/html/grantflow/vite.svg

# If missing, copy it
sudo cp /opt/grantflow/dist/vite.svg /var/www/html/grantflow/
```

### CORS Errors

**Symptom:** Browser console shows CORS errors

**Solution:**
```bash
# Verify CORS_ORIGIN in backend .env
sudo nano /opt/grantflow/.env

# Should include:
# CORS_ORIGIN=https://app.axiombiolabs.org,https://www.axiombiolabs.org

# Restart backend
sudo systemctl restart grantflow-backend
```

### API Requests Failing

**Symptom:** API calls return 502 Bad Gateway or timeout

**Possible Causes:**

1. **Backend not listening on port 4000:**
   ```bash
   # Check if port is listening
   sudo netstat -tlnp | grep 4000
   
   # Should show node process listening
   ```

2. **Firewall blocking localhost:**
   ```bash
   # Ensure localhost is not blocked
   sudo iptables -L
   ```

3. **Backend crashed:**
   ```bash
   # Check logs
   sudo journalctl -u grantflow-backend -n 50
   
   # Restart service
   sudo systemctl restart grantflow-backend
   ```

### SSL Certificate Issues

**For Cloudflare Origin Certificate:**
```bash
# Verify certificate files exist
sudo ls -la /etc/nginx/ssl/

# Check certificate validity
sudo openssl x509 -in /etc/nginx/ssl/cloudflare-origin.crt -noout -dates

# Test nginx SSL config
sudo nginx -t
```

**For Let's Encrypt:**
```bash
# Renew certificate manually
sudo certbot renew

# Check renewal timer
sudo systemctl status certbot.timer
```

### SPA Routing Not Working

**Symptom:** Refreshing on routes like `/grantflow/dashboard` returns 404

**Solution:**
```bash
# Verify nginx try_files directive
sudo grep -A 5 "location /grantflow" /etc/nginx/sites-available/grantflow.conf

# Should include:
# try_files $uri $uri/ /grantflow/index.html;

# Reload nginx
sudo systemctl reload nginx
```

---

## 10. Maintenance

### Updating the Application

```bash
# Stop services
sudo systemctl stop grantflow-backend

# Pull latest changes
cd /opt/grantflow
git pull origin main

# Install dependencies
npm install --production

# Rebuild frontend
npm run build

# Deploy frontend
sudo cp -r dist/* /var/www/html/grantflow/

# Restart backend
sudo systemctl start grantflow-backend

# Verify deployment
curl https://app.axiombiolabs.org/grantflow/api/health
```

### Backup Strategy

```bash
# Backup script
#!/bin/bash
BACKUP_DIR="/backup/grantflow/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Backup application files
tar -czf "$BACKUP_DIR/app.tar.gz" /opt/grantflow

# Backup nginx config
cp /etc/nginx/sites-available/grantflow.conf "$BACKUP_DIR/"

# Backup environment
sudo -u grantflow cp /opt/grantflow/.env "$BACKUP_DIR/env.backup"

# Backup data directory
tar -czf "$BACKUP_DIR/data.tar.gz" /opt/grantflow/backend/data
```

### Log Rotation

```bash
# Backend logs are handled by journald
# Nginx logs need rotation configuration

sudo nano /etc/logrotate.d/grantflow-nginx

# Add:
/var/log/nginx/grantflow*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 `cat /var/run/nginx.pid`
        fi
    endscript
}
```

### Monitoring Setup

```bash
# Set up basic monitoring with systemd
sudo systemctl enable grantflow-backend

# Monitor service status
watch -n 5 'systemctl status grantflow-backend'

# Set up email alerts (optional)
# Install mailutils
sudo apt install mailutils

# Configure systemd to send email on failure
sudo systemctl edit grantflow-backend
# Add:
[Service]
OnFailure=status-email@%n.service
```

### Performance Optimization

```bash
# Enable gzip compression in nginx (already in config)
# Enable caching headers (already in config)

# Monitor memory usage
htop

# Monitor disk usage
df -h

# Clean old logs
sudo journalctl --vacuum-time=7d
```

---

## Quick Deployment Script

For automated deployments, use the provided script:

```bash
# Make script executable
chmod +x /opt/grantflow/scripts/deploy-production.sh

# Run deployment
./scripts/deploy-production.sh
```

---

## Security Checklist

- [ ] Strong `ANYA_ADMIN_TOKEN` generated and set
- [ ] `.env` file has restricted permissions (600)
- [ ] Firewall configured (UFW)
- [ ] SSL/TLS enabled (via Cloudflare or Let's Encrypt)
- [ ] CORS restricted to production domains only
- [ ] Backend only accessible via localhost (not exposed)
- [ ] Regular security updates applied
- [ ] Sensitive logs not exposed publicly
- [ ] API keys rotated regularly

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/buckeye7066/GrantFlow/issues
- Check logs: `sudo journalctl -u grantflow-backend -f`
- Nginx logs: `sudo tail -f /var/log/nginx/error.log`

---

## Additional Resources

- [Nginx Documentation](https://nginx.org/en/docs/)
- [Cloudflare Origin Certificates](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Digital Ocean Tutorials](https://www.digitalocean.com/community/tutorials)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
