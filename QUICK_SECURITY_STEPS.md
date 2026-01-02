# Quick Security Steps - GrantFlow

## ✅ Completed (in commit 02f6f2b)
- Removed `.env` from git tracking
- File still exists locally but won't be committed anymore

## 🔴 CRITICAL - Do These Now

### 1. Make Repository Private (Your "Password")

**Steps:**
1. Go to: https://github.com/buckeye7066/GrantFlow/settings
2. Scroll to bottom → "Danger Zone"
3. Click "Change visibility" → "Make private"
4. Type repository name to confirm

**Result:** Only you and invited collaborators can access the repo. This protects the exposed secret in git history.

### 2. Change the Exposed Token

The token `ANYA_ADMIN_TOKEN=grantflow-admin-admin` is in git history. Change it:

**Generate a new secure token:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Example result:** `76cda1bf5fa5bda78da95325d3465cda1c7f330639dba751c6d2c7388f441726`

**Update in 3 places:**
1. Your local `.env` file
2. Railway dashboard (Settings → Variables)
3. Any other deployment environments

### 3. Add Branch Protection (Optional but Recommended)

1. Go to: https://github.com/buckeye7066/GrantFlow/settings/branches
2. Add rule for `main` branch
3. Enable "Require pull request reviews"

## 📋 Summary

| Action | Status | Priority |
|--------|--------|----------|
| Stop tracking .env | ✅ Done | - |
| Make repo private | ⏳ TODO | 🔴 CRITICAL |
| Rotate ANYA_ADMIN_TOKEN | ⏳ TODO | 🔴 CRITICAL |
| Update token in Railway | ⏳ TODO | 🔴 CRITICAL |
| Add branch protection | ⏳ TODO | 🟡 Recommended |

## Questions?

See `SECURITY_SETUP_GUIDE.md` for detailed instructions on all security options.
