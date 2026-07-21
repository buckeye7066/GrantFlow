// Windows shortcut / target resolution. A .lnk or .url file is a POINTER, not
// the application — and its LABEL is never trusted to identify the app. We
// resolve a shortcut to its real target path, but the app identity always comes
// from the manifest's app_id + the repo it lives in, never the shortcut name.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Resolve a .url (INI-style) shortcut's URL= line. Pure text parse.
export function resolveUrlShortcut(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const m = text.match(/^URL=(.+)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

// Resolve a .lnk target via PowerShell's WScript.Shell (Windows only). Returns
// { targetPath, arguments, workingDirectory } or null. We deliberately DO NOT
// execute the target — we only read where it points, so a manifest can be
// cross-checked against the real path rather than the shortcut's display name.
export function resolveLnkShortcut(path) {
  try {
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.replace(/'/g, "''")}');` +
      `[Console]::Out.Write(($s.TargetPath + '|' + $s.Arguments + '|' + $s.WorkingDirectory))`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 10000,
      encoding: 'utf8',
    })
    const [targetPath, args, wd] = String(out).split('|')
    return { targetPath: targetPath || null, arguments: args || '', workingDirectory: wd || null }
  } catch {
    return null
  }
}

// Given a manifest and (optionally) a shortcut, verify the shortcut points into
// the manifest's declared repo/local_path. Returns { ok, reason }. This is the
// "a shortcut is only a pointer; do not infer the app from its label" guard.
export function verifyShortcutMatchesManifest(shortcutTarget, manifest) {
  if (!shortcutTarget || !manifest?.local_path) return { ok: true, reason: 'no shortcut to verify' }
  const target = String(shortcutTarget).toLowerCase().replace(/\\/g, '/')
  const expected = String(manifest.local_path).toLowerCase().replace(/\\/g, '/')
  if (target.includes(expected)) return { ok: true, reason: 'shortcut resolves into manifest local_path' }
  return { ok: false, reason: `shortcut target ${shortcutTarget} does not resolve into ${manifest.local_path}` }
}
