# Required GitHub Secrets

Go to: https://github.com/buckeye7066/GrantFlow/settings/secrets/actions

Add these secrets:

1. **DO_HOST**: `138.197.30.220`
2. **DO_PASSWORD**: Your DigitalOcean root password (the one you use to SSH)
3. **ANYA_ADMIN_TOKEN**: `OLIVIA-2024` (or any admin token)
4. **OPENAI_API_KEY**: Your OpenAI API key
5. **ANTHROPIC_API_KEY**: Your Anthropic API key

## How to Deploy

1. Go to: https://github.com/buckeye7066/GrantFlow/actions
2. Click "Deploy to DigitalOcean" workflow
3. Click "Run workflow"
4. Wait 2-3 minutes
5. Visit: https://app.axiombiolabs.org/grantflow/login

## Security Note

The workflow uses password authentication over SSH. The password is stored securely in GitHub Secrets and is never exposed in logs.

For production environments, consider switching to SSH key-based authentication by:
1. Generating an SSH key pair on the server
2. Adding the public key to `~/.ssh/authorized_keys`
3. Storing the private key in GitHub Secrets as `DO_SSH_KEY`
4. Updating the workflow to use `key:` instead of `password:`

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
