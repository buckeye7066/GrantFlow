# Windows: Fix `npm` EPERM (locked `esbuild.exe`)

On Windows, `npm ci` can fail with `EPERM: operation not permitted, unlink ...\\node_modules\\@esbuild\\win32-x64\\esbuild.exe` when a running Node process (dev server, test runner, IDE extension, etc.) still has the binary open.

This repo intentionally **does not** “skip installs” or add security-reducing hacks. Use the steps below.

## Quick fix (manual)

1. Stop any running processes that may be using node_modules binaries:
   - Close dev servers, Playwright runs, and terminals running `node`, `vite`, `playwright`, or the backend.
2. Kill lingering processes (PowerShell):

```powershell
Get-Process node, esbuild -ErrorAction SilentlyContinue | Stop-Process -Force
```

3. Remove `node_modules`:

```powershell
Remove-Item -Recurse -Force .\\node_modules
```

4. Run a resilient install first:

```powershell
npm install --no-audit --no-fund
```

5. After that succeeds, you can try the fully clean/reproducible install:

```powershell
npm ci --no-audit --no-fund
```

## Scripted fix

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\windows-npm-repair.ps1
```

