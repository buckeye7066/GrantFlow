#!/bin/bash

##############################################################################
# GrantFlow Production Deployment Script
# 
# This script automates the deployment process for GrantFlow to production.
# It builds the frontend, deploys static files, and restarts services.
#
# Usage:
#   ./scripts/deploy-production.sh [--skip-build] [--skip-backend]
#
# Options:
#   --skip-build    Skip the frontend build step
#   --skip-backend  Skip the backend restart step
#
# Prerequisites:
#   - Run this script on the production server or with SSH access
#   - Backend service must be set up as systemd service
#   - Nginx must be configured and running
##############################################################################

set -e  # Exit on error
set -u  # Exit on undefined variable

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_DIR="/opt/grantflow"
WEB_ROOT="/var/www/html/grantflow"
BACKUP_DIR="/var/backups/grantflow"
SERVICE_NAME="grantflow-backend"

# Parse arguments
SKIP_BUILD=false
SKIP_BACKEND=false

for arg in "$@"; do
    case $arg in
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --skip-backend)
            SKIP_BACKEND=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--skip-build] [--skip-backend]"
            echo ""
            echo "Options:"
            echo "  --skip-build    Skip the frontend build step"
            echo "  --skip-backend  Skip the backend restart step"
            echo "  --help, -h      Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown argument: $arg${NC}"
            exit 1
            ;;
    esac
done

# Helper functions
print_step() {
    echo -e "\n${BLUE}==>${NC} ${GREEN}$1${NC}"
}

print_info() {
    echo -e "${BLUE}Info:${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}Warning:${NC} $1"
}

print_error() {
    echo -e "${RED}Error:${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

# Check if running on production server
check_environment() {
    print_step "Checking environment..."
    
    if [[ ! -d "$APP_DIR" ]]; then
        print_error "Application directory not found: $APP_DIR"
        exit 1
    fi
    
    if [[ ! -f "$APP_DIR/.env" ]]; then
        print_warning ".env file not found. Make sure to configure it before starting the backend."
    fi
    
    print_success "Environment check passed"
}

# Create backup of current deployment
create_backup() {
    print_step "Creating backup..."
    
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"
    
    mkdir -p "$BACKUP_PATH"
    
    if [[ -d "$WEB_ROOT" ]]; then
        sudo cp -r "$WEB_ROOT" "${BACKUP_PATH}/frontend" 2>/dev/null || true
        print_success "Frontend backup created at ${BACKUP_PATH}/frontend"
    fi
    
    # Keep only last 5 backups
    if [[ -d "$BACKUP_DIR" ]]; then
        cd "$BACKUP_DIR"
        ls -t | tail -n +6 | xargs -r rm -rf
        print_info "Cleaned old backups (keeping last 5)"
    fi
}

# Pull latest code
update_code() {
    print_step "Updating code from repository..."
    
    cd "$APP_DIR"
    
    # Stash any local changes
    git stash save "Auto-stash before deployment $(date +%Y%m%d_%H%M%S)" || true
    
    # Pull latest changes
    git pull origin main
    
    print_success "Code updated successfully"
}

# Install/update dependencies
install_dependencies() {
    print_step "Installing dependencies..."
    
    cd "$APP_DIR"
    npm install --production
    
    print_success "Dependencies installed"
}

# Build frontend
build_frontend() {
    if [[ "$SKIP_BUILD" == true ]]; then
        print_warning "Skipping frontend build (--skip-build flag set)"
        return
    fi
    
    print_step "Building frontend..."
    
    cd "$APP_DIR"
    
    # Ensure build directory is clean
    rm -rf dist
    
    # Build with production settings
    NODE_ENV=production npm run build
    
    if [[ ! -d "dist" ]] || [[ ! -f "dist/index.html" ]]; then
        print_error "Build failed - dist directory or index.html not found"
        exit 1
    fi
    
    print_success "Frontend built successfully"
}

# Deploy frontend files
deploy_frontend() {
    print_step "Deploying frontend files..."
    
    if [[ ! -d "$APP_DIR/dist" ]]; then
        print_error "Build directory not found: $APP_DIR/dist"
        print_info "Run with build enabled or build manually first"
        exit 1
    fi
    
    # Create web root if it doesn't exist
    sudo mkdir -p "$WEB_ROOT"
    
    # Copy files
    sudo cp -r "$APP_DIR/dist/"* "$WEB_ROOT/"
    
    # Set permissions
    sudo chown -R www-data:www-data "$WEB_ROOT"
    sudo chmod -R 755 "$WEB_ROOT"
    
    print_success "Frontend deployed to $WEB_ROOT"
}

# Restart backend service
restart_backend() {
    if [[ "$SKIP_BACKEND" == true ]]; then
        print_warning "Skipping backend restart (--skip-backend flag set)"
        return
    fi
    
    print_step "Restarting backend service..."
    
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
        print_warning "Service $SERVICE_NAME is not running, starting it..."
        sudo systemctl start "$SERVICE_NAME"
    else
        sudo systemctl restart "$SERVICE_NAME"
    fi
    
    # Wait for service to be ready
    sleep 2
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        print_success "Backend service restarted successfully"
    else
        print_error "Failed to restart backend service"
        sudo systemctl status "$SERVICE_NAME"
        exit 1
    fi
}

# Reload Nginx
reload_nginx() {
    print_step "Reloading Nginx..."
    
    # Test configuration first
    if ! sudo nginx -t; then
        print_error "Nginx configuration test failed"
        exit 1
    fi
    
    sudo systemctl reload nginx
    
    print_success "Nginx reloaded successfully"
}

# Verify deployment
verify_deployment() {
    print_step "Verifying deployment..."
    
    # Check if files exist
    if [[ ! -f "$WEB_ROOT/index.html" ]]; then
        print_error "index.html not found in $WEB_ROOT"
        exit 1
    fi
    print_success "Frontend files deployed"
    
    # Check backend health
    sleep 2
    if curl -f -s http://localhost:4000/api/health > /dev/null; then
        print_success "Backend health check passed"
    else
        print_error "Backend health check failed"
        print_info "Check logs with: sudo journalctl -u $SERVICE_NAME -n 50"
        exit 1
    fi
    
    # Check Nginx
    if systemctl is-active --quiet nginx; then
        print_success "Nginx is running"
    else
        print_error "Nginx is not running"
        exit 1
    fi
}

# Display deployment summary
deployment_summary() {
    print_step "Deployment Summary"
    
    echo ""
    echo "Application: GrantFlow"
    echo "Deployed to: $WEB_ROOT"
    echo "Backend service: $SERVICE_NAME"
    echo "Time: $(date)"
    echo ""
    
    # Get service status
    SERVICE_STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown")
    echo "Backend Status: $SERVICE_STATUS"
    
    # Get nginx status
    NGINX_STATUS=$(systemctl is-active nginx 2>/dev/null || echo "unknown")
    echo "Nginx Status: $NGINX_STATUS"
    
    echo ""
    print_info "View logs with:"
    echo "  Backend: sudo journalctl -u $SERVICE_NAME -f"
    echo "  Nginx:   sudo tail -f /var/log/nginx/grantflow-error.log"
    
    echo ""
    print_success "Deployment completed successfully!"
    echo ""
    print_info "Access your application at:"
    echo "  https://app.axiombiolabs.org/grantflow/"
}

# Main deployment flow
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║         GrantFlow Production Deployment Script            ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    
    check_environment
    create_backup
    update_code
    install_dependencies
    build_frontend
    deploy_frontend
    restart_backend
    reload_nginx
    verify_deployment
    deployment_summary
}

# Run main function
main
