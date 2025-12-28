# Required GitHub Secrets

Go to: https://github.com/buckeye7066/GrantFlow/settings/secrets/actions

Add these secrets:

1. **DO_HOST**: `138.197.30.220`
2. **DO_SSH_KEY**: Your DigitalOcean SSH private key
3. **ANYA_ADMIN_TOKEN**: `OLIVIA-2024` (or any admin token)
4. **OPENAI_API_KEY**: `sk-proj-...` (provided)
5. **ANTHROPIC_API_KEY**: `sk-ant-...` (provided)

## How to Deploy

1. Go to: https://github.com/buckeye7066/GrantFlow/actions
2. Click "Deploy to DigitalOcean" workflow
3. Click "Run workflow"
4. Wait 2-3 minutes
5. Visit: https://app.axiombiolabs.org/grantflow/login

## SSH Key Setup

If you don't have DO_SSH_KEY:
```bash
# On your local machine
ssh root@138.197.30.220
cat ~/.ssh/authorized_keys
# Copy the private key that matches
```

## Troubleshooting

### Deployment Failed

Check the workflow logs:
1. Go to: https://github.com/buckeye7066/GrantFlow/actions
2. Click on the failed workflow run
3. Review the error messages

### Backend Health Check Failed

SSH into the server and check:
```bash
ssh root@138.197.30.220
systemctl status grantflow-backend
journalctl -u grantflow-backend -n 50
```

### Frontend Not Loading

Check if files were deployed:
```bash
ssh root@138.197.30.220
ls -la /var/www/html/grantflow/
nginx -t
systemctl status nginx
```

## Manual Deployment Alternative

If the GitHub Actions workflow fails, you can manually run the deployment:

```bash
ssh root@138.197.30.220
cd /var/www/grantflow
git pull origin main
npm install
npm run build
cp -r dist/* /var/www/html/grantflow/
systemctl restart grantflow-backend
systemctl reload nginx
```
