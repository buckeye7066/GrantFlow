#!/usr/bin/env bash
# deploy-production.sh – Automated deployment to Digital Ocean droplet
#
# Usage (run on the server or via SSH):
#   ./scripts/deploy-production.sh
#
# Prerequisites:
#   - Node 20.20.2 installed (see .nvmrc)
#   - Nginx configured (nginx/grantflow.conf symlinked in sites-enabled)
#   - systemd service installed (systemd/grantflow-backend.service)
#   - /opt/grantflow/.env.production populated from .env.production.example
#
set -euo pipefail

APP_DIR=/opt/grantflow
WEB_ROOT=/var/www/html/grantflow
BACKUP_DIR=/opt/grantflow-backups
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
HEALTH_URL=http://127.0.0.1:4000/api/health

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── 1. Backup current deployment ─────────────────────────────────────────────
log "Creating backup → $BACKUP_DIR/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"
if [ -d "$WEB_ROOT" ]; then
  tar -czf "$BACKUP_DIR/${TIMESTAMP}_frontend.tar.gz" -C "$WEB_ROOT" . || true
fi
if [ -f "$APP_DIR/backend/data/grantflow.db" ]; then
  cp "$APP_DIR/backend/data/grantflow.db" "$BACKUP_DIR/${TIMESTAMP}_grantflow.db" || true
fi

# Keep only the 5 most recent backups (frontend archives and DB snapshots)
ls -dt "$BACKUP_DIR"/*_frontend.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f || true
ls -dt "$BACKUP_DIR"/*_grantflow.db    2>/dev/null | tail -n +6 | xargs rm -f || true

# ── 2. Pull latest code ───────────────────────────────────────────────────────
log "Pulling latest code"
cd "$APP_DIR"
git fetch origin
git checkout main
git pull origin main

# ── 3. Install dependencies ───────────────────────────────────────────────────
log "Installing dependencies (npm ci)"
npm ci --omit=dev

# ── 4. Build frontend ─────────────────────────────────────────────────────────
log "Building frontend"
NODE_ENV=production npm run build

# ── 5. Deploy frontend assets ─────────────────────────────────────────────────
log "Deploying frontend to $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete dist/ "$WEB_ROOT/"
chmod -R 755 "$WEB_ROOT"

# ── 6. Restart backend service ────────────────────────────────────────────────
log "Restarting grantflow-backend service"
systemctl restart grantflow-backend
sleep 3

# ── 7. Reload Nginx ──────────────────────────────────────────────────────────
log "Reloading Nginx"
nginx -t && systemctl reload nginx

# ── 8. Health check ──────────────────────────────────────────────────────────
log "Running health check"
for i in 1 2 3 4 5; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
  if [ "$STATUS" = "200" ]; then
    log "Health check passed (HTTP $STATUS)"
    break
  fi
  log "Attempt $i: HTTP $STATUS – waiting 5s"
  sleep 5
  if [ "$i" = "5" ]; then
    log "Health check failed after 5 attempts – attempting rollback"
    LATEST_FRONTEND=$(ls -dt "$BACKUP_DIR"/*_frontend.tar.gz 2>/dev/null | head -1 || true)
    LATEST_DB=$(ls -dt "$BACKUP_DIR"/*_grantflow.db 2>/dev/null | head -1 || true)
    if [ -n "$LATEST_FRONTEND" ]; then
      log "Restoring frontend from $LATEST_FRONTEND"
      rm -rf "${WEB_ROOT:?}"/*
      tar -xzf "$LATEST_FRONTEND" -C "$WEB_ROOT"
      systemctl reload nginx || true
    fi
    if [ -n "$LATEST_DB" ]; then
      log "Restoring database from $LATEST_DB"
      systemctl stop grantflow-backend || true
      cp "$LATEST_DB" "$APP_DIR/backend/data/grantflow.db"
      systemctl start grantflow-backend || true
    fi
    die "Deployment failed – rollback attempted. Check logs: journalctl -u grantflow-backend -n 50"
  fi
done

log "✅ Deployment complete – $TIMESTAMP"
