import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Loader2, RefreshCw, Download, CheckCircle2 } from 'lucide-react'
import { version as APP_VERSION } from '../../../package.json'
import {
  downloadAndApplyUpdate,
  fetchUpdateManifest,
  isNewerVersion,
  parseVersion,
  requiresNativeUpdate,
} from '@/lib/mobileUpdater'

/**
 * "App Updates" card for the Settings page. Only rendered inside the native
 * Capacitor app — web deployments update themselves on every page load, so the
 * card renders nothing there.
 *
 * Manual OTA flow (autoUpdate is disabled in capacitor.config.json):
 * check `/mobile/latest.json` → compare against the active bundle version →
 * download + apply via @capgo/capacitor-updater → reload.
 */
export default function MobileUpdateCard() {
  const isNative = Capacitor.isNativePlatform()
  const [nativeVersion, setNativeVersion] = useState('')
  const [bundleVersion, setBundleVersion] = useState(APP_VERSION)
  // idle | checking | available | native-required | downloading | applying | uptodate | error
  const [phase, setPhase] = useState('idle')
  const [manifest, setManifest] = useState(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)
  const checkingRef = useRef(false)
  const downloadingRef = useRef(false)

  useEffect(() => {
    if (!isNative) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
        const current = await CapacitorUpdater.current()
        if (cancelled) return
        // "builtin" means the bundle baked into the APK — its web version is
        // the package.json version captured at build time.
        const v = current?.bundle?.version
        setBundleVersion(parseVersion(v) ? v : APP_VERSION)
        if (current?.native) setNativeVersion(String(current.native))
      } catch (err) {
        // Plugin unavailable (e.g. old APK without it) — keep baked version.
        console.warn('CapacitorUpdater unavailable:', err?.message || err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isNative])

  const checkForUpdates = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setPhase('checking')
    setError('')
    setManifest(null)
    try {
      const found = await fetchUpdateManifest()
      if (isNewerVersion(found.version, bundleVersion)) {
        setManifest(found)
        setPhase('available')
      } else {
        setPhase('uptodate')
      }
    } catch (err) {
      setError(err?.message || 'Update check failed.')
      setPhase('error')
    } finally {
      checkingRef.current = false
    }
  }, [bundleVersion])

  const downloadAndApply = useCallback(async () => {
    if (!manifest || downloadingRef.current) return
    downloadingRef.current = true
    setPhase('downloading')
    setError('')
    setProgress(0)
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
      // Single shared apply path (also used by MobileUpdateWatcher): it refuses
      // a manifest with no published sha256 and hands the digest to the plugin,
      // which verifies the downloaded zip and throws on mismatch. There is no
      // code path here that applies an unverified bundle.
      await downloadAndApplyUpdate({
        manifest,
        updater: CapacitorUpdater,
        onProgress: (percent) => {
          setProgress(percent)
          setPhase('downloading')
        },
      })
      setPhase('applying')
    } catch (err) {
      setError(err?.message || 'Update download failed.')
      setPhase('error')
    } finally {
      downloadingRef.current = false
    }
  }, [manifest])

  if (!isNative) return null

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'applying'
  // OTA replaces the web bundle only — a bundle declaring a native floor above
  // the installed app must be reported as "install a new app version", never
  // offered as a web update that cannot deliver it. Derived at RENDER, not
  // frozen when the check ran: the native version loads asynchronously, so a
  // fast tap could otherwise be adjudicated against an empty version and slip
  // past this gate.
  const nativeRequired = Boolean(manifest) && requiresNativeUpdate(manifest, nativeVersion)

  return (
    <Card>
      <CardHeader>
        <CardTitle>App Updates</CardTitle>
        <CardDescription>
          App v{nativeVersion || '?'} — web bundle v{bundleVersion}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {phase === 'uptodate' && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>Up to date (v{bundleVersion}).</AlertDescription>
          </Alert>
        )}
        {phase === 'available' && manifest && !nativeRequired && (
          <Alert>
            <AlertDescription>
              Update available: v{manifest.version}
              {manifest.notes ? ` — ${manifest.notes}` : ''}
            </AlertDescription>
          </Alert>
        )}
        {phase === 'available' && nativeRequired && manifest && (
          <Alert>
            <AlertDescription>
              A new app version is required. GrantFlow v{manifest.version} needs app version{' '}
              {manifest.minNativeVersion} or newer — install the latest GrantFlow app to get it. An
              in-app update replaces the web bundle only and cannot deliver this change.
            </AlertDescription>
          </Alert>
        )}
        {phase === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {phase === 'downloading' && (
          <div className="space-y-2">
            <Progress value={progress} />
            <p className="text-sm text-slate-500">Downloading update… {Math.round(progress)}%</p>
          </div>
        )}
        {phase === 'applying' && (
          <p className="text-sm text-slate-500">Applying update and reloading…</p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={checkForUpdates} disabled={busy}>
            {phase === 'checking' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Check for Updates
          </Button>
          {phase === 'available' && manifest && !nativeRequired && (
            <Button onClick={downloadAndApply} disabled={busy}>
              <Download className="h-4 w-4 mr-2" />
              Install v{manifest.version}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
