import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Loader2, RefreshCw, Download, CheckCircle2 } from 'lucide-react'
import { version as APP_VERSION } from '../../../package.json'
import { fetchUpdateManifest, isNewerVersion, parseVersion } from '@/lib/mobileUpdater'

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
  const [phase, setPhase] = useState('idle') // idle | checking | available | downloading | applying | uptodate | error
  const [manifest, setManifest] = useState(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)
  const listenerRef = useRef(null)
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
      listenerRef.current?.remove?.()
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
      listenerRef.current = await CapacitorUpdater.addListener('download', (event) => {
        if (typeof event?.percent === 'number') setProgress(event.percent)
      })
      const bundle = await CapacitorUpdater.download({ url: manifest.url, version: manifest.version })
      listenerRef.current?.remove?.()
      listenerRef.current = null
      setPhase('applying')
      // set() swaps to the new bundle and reloads the webview.
      await CapacitorUpdater.set(bundle)
    } catch (err) {
      listenerRef.current?.remove?.()
      listenerRef.current = null
      setError(err?.message || 'Update download failed.')
      setPhase('error')
    } finally {
      downloadingRef.current = false
    }
  }, [manifest])

  if (!isNative) return null

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'applying'

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
        {phase === 'available' && manifest && (
          <Alert>
            <AlertDescription>
              Update available: v{manifest.version}
              {manifest.notes ? ` — ${manifest.notes}` : ''}
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
          {phase === 'available' && manifest && (
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
