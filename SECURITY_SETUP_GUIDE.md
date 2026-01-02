# Security Setup Guide for GrantFlow Repository

## Immediate Actions Required

### 1. Remove .env from Git History

The `.env` file contains secrets and should never be tracked in git. To remove it completely:

```bash
# Remove .env from git tracking (keeps local file)
git rm --cached .env

# Commit the removal
git commit -m "Stop tracking .env file"

# Push changes
git push origin copilot/fix-tab-switching-issue
```

**Important**: This only removes it from future commits. The secret `ANYA_ADMIN_TOKEN=grantflow-admin-admin` is still in the git history and visible to anyone with access to the repository.

### 2. Rotate the Exposed Secret

Since `ANYA_ADMIN_TOKEN=grantflow-admin-admin` is in the git history:

1. **Change the token immediately** to a new, strong value
2. Update it in your actual `.env` file (not in git)
3. Update it wherever the backend is deployed (Railway, Vercel, etc.)

Generate a strong token:
```bash
# Option 1: Using OpenSSL
openssl rand -hex 32

# Option 2: Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Make Repository Private (Recommended)

**To add a "password" to your repo, make it private:**

1. Go to GitHub: https://github.com/buckeye7066/GrantFlow
2. Click **Settings** (in the repository menu)
3. Scroll down to the **Danger Zone** section
4. Click **Change visibility**
5. Select **Make private**
6. Confirm by typing the repository name

**Benefits:**
- Only you and collaborators you invite can access the code
- Secrets in git history won't be publicly visible
- Free for personal repositories

### 4. Use GitHub Secrets for CI/CD

If you're using GitHub Actions, store secrets securely:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add secrets like:
   - `ANYA_ADMIN_TOKEN`
   - `OPENAI_API_KEY`
   - Any other sensitive values

Reference them in workflows:
```yaml
env:
  ANYA_ADMIN_TOKEN: ${{ secrets.ANYA_ADMIN_TOKEN }}
```

### 5. Set Up Branch Protection Rules

Protect your main branches from accidental secret commits:

1. Go to **Settings** → **Branches**
2. Click **Add branch protection rule**
3. For branch name pattern: `main` (or `master`)
4. Enable:
   - ✅ Require pull request reviews before merging
   - ✅ Require status checks to pass
   - ✅ Require branches to be up to date
   - ✅ Include administrators

### 6. Configure .gitignore Properly

Your `.gitignore` already includes `.env`, which is correct. Verify it:

```bash
cat .gitignore | grep "^\.env$"
```

Should return: `.env`

### 7. Clean Up Git History (Advanced - Optional)

If you want to completely remove the secret from git history:

**⚠️ WARNING: This rewrites history and requires force-push**

```bash
# Install git-filter-repo (safer than filter-branch)
pip install git-filter-repo

# Remove .env from entire history
git filter-repo --path .env --invert-paths

# Force push to all branches (dangerous!)
git push origin --force --all
```

**Note:** This will break any open PRs and require all collaborators to re-clone.

## Best Practices Going Forward

### 1. Never Commit Secrets

- Use `.env` files locally (already in `.gitignore`)
- Use environment variables in production
- Use secret management services (GitHub Secrets, AWS Secrets Manager, etc.)

### 2. Environment-Specific Files

Keep this structure:
```
.env                    # Local development (NOT in git)
.env.example           # Template (safe to commit)
.env.production.example # Production template (safe to commit)
```

### 3. Automated Secret Scanning

Consider adding:
- **GitGuardian** or **TruffleHog** for secret scanning
- **Pre-commit hooks** to catch secrets before commit
- **GitHub secret scanning** (automatic for public repos)

### 4. Regular Security Audits

```bash
# Check for exposed secrets in dependencies
npm audit

# Scan for secrets in code
npx gitleaks detect --source . --verbose
```

## Deployment Security

### For Railway/Vercel:

1. Add environment variables in the dashboard:
   - Railway: Settings → Variables
   - Vercel: Settings → Environment Variables

2. Never hardcode secrets in:
   - Configuration files
   - Docker images
   - Source code

### For Production:

```bash
# Set environment variables (example)
export ANYA_ADMIN_TOKEN="your-new-secure-token-here"
export OPENAI_API_KEY="your-openai-key-here"
```

## Summary Checklist

- [ ] Stop tracking .env file: `git rm --cached .env`
- [ ] Rotate the `ANYA_ADMIN_TOKEN` to a new secure value
- [ ] Make repository private (Settings → Change visibility)
- [ ] Add secrets to GitHub Secrets (for CI/CD)
- [ ] Set up branch protection rules
- [ ] Verify .gitignore includes .env
- [ ] Update production environment variables
- [ ] (Optional) Clean git history with git-filter-repo

## Questions?

If you need help with any of these steps, let me know which specific area you'd like assistance with.
