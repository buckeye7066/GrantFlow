import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Download, Loader2 } from 'lucide-react'
import { version as APP_VERSION } from '../../../package.json'
import {
  downloadAndApplyUpdate,
  fetchUpdateManifest,
  isNewerVersion,
  parseVersion,
  requiresNativeUpdate,
} from '@/lib/mobileUpdater'
import { notifyUpdateAvailable } from '@/lib/mobileUpdateNotifier'

/**
 * Minimum gap between automatic feed checks. Foreground/background cycling is
 * frequent on mobile; without this, a user flipping between apps would hammer
 * the feed. The Settings card's MANUAL "Check for Updates" button is never
 * throttled — this only bounds the automatic launch/resume checks.
 */
export const AUTO_CHECK_COOLDOWN_MS = 15 * 60 * 1000

/**
 * Launch + resume OTA update watcher.
 *
 * This is the piece that makes updates arrive on their own: on app launch and
 * on every return from the background it checks the published feed, and when a
 * newer web bundle exists it (a) raises a LOCAL notification and (b) shows an
 * in-app prompt whose Install button is one tap away — instead of requiring the
 * user to remember to open Settings.
 *
 * Deliberately NOT server push: FCM/APNs would need a Firebase project, an
 * Apple push key, and a sending service that this project has not provisioned.
 * A resume check + local notification works on Android and iOS today with zero
 * backend. A future real push trigger can call handleManifest() unchanged.
 *
 * Renders nothing on the web (browsers reload the newest build on every page
 * load) and nothing until an update is actually found.
 */
export default function MobileUpdateWatcher() {
  const isNative = Capacitor.isNativePlatform()
  const [manifest, setManifest] = useState(null)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | installing | error | native-required
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const bundleVersionRef = useRef(APP_VERSION)
  const nativeVersionRef = useRef('')
  const lastCheckRef = useRef(0)
  const checkingRef = useRef(false)
  const dismissedVersionRef = useRef('')

  /**
   * Decide what to do with a fetched manifest. Kept separate from the transport
   * so a future push payload can drive the exact same behavior.
   */
  const handleManifest = useCallback(async (found) => {
    const currentVersion = bundleVersionRef.current
    if (!isNewerVersion(found.version, currentVersion)) return
    if (dismissedVersionRef.current === found.version) return

    // Notification is best-effort and gated (once per version, silent when the
    // permission is denied). It must never gate the in-app prompt below.
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      await notifyUpdateAvailable({
        manifest: found,
        currentVersion,
        localNotifications: LocalNotifications,
      })
    } catch {
      // Plugin absent in an older native build — in-app prompt still shows.
    }

    setManifest(found)
    // OTA can only replace the WEB bundle. If this bundle declares a native
    // floor above the installed app, say so instead of offering a web update
    // that cannot carry the change.
    setPhase(requiresNativeUpdate(found, nativeVersionRef.current) ? 'native-required' : 'idle')
    setOpen(true)
  }, [])

  const runCheck = useCallback(
    async ({ force = false } = {}) => {
      if (checkingRef.current) return
      const now = Date.now()
      if (!force && now - lastCheckRef.current < AUTO_CHECK_COOLDOWN_MS) return
      checkingRef.current = true
      lastCheckRef.current = now
      try {
        const found = await fetchUpdateManifest()
        await handleManifest(found)
      } catch {
        // A background check must be silent about transport failures — the
        // Settings card is where a user asks for (and deserves) an error.
      } finally {
        checkingRef.current = false
      }
    },
    [handleManifest],
  )

  // Read the active bundle + native app version, then run the launch check.
  useEffect(() => {
    if (!isNative) return undefined
    let cancelled = false
    const removers = []

    ;(async () => {
      try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
        const current = await CapacitorUpdater.current()
        if (cancelled) return
        const v = current?.bundle?.version
        bundleVersionRef.current = parseVersion(v) ? v : APP_VERSION
        if (current?.native) nativeVersionRef.current = String(current.native)
      } catch {
        // Plugin unavailable — keep the baked package.json version.
      }
      if (cancelled) return
      await runCheck({ force: true })
    })()

    // Resume trigger #1: Capacitor's App plugin (the native-accurate signal).
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) runCheck()
        })
        if (cancelled) handle?.remove?.()
        else removers.push(() => handle?.remove?.())
      } catch {
        // Plugin absent — the visibilitychange fallback below still fires.
      }
    })()

    // Resume trigger #2: the DOM signal, which the WebView also raises on
    // foreground. Harmless when both fire — runCheck is cooldown-guarded.
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') runCheck()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
      removers.push(() => document.removeEventListener('visibilitychange', onVisible))
    }

    return () => {
      cancelled = true
      removers.forEach((remove) => remove())
    }
  }, [isNative, runCheck])

  const install = useCallback(async () => {
    if (!manifest) return
    setPhase('installing')
    setError('')
    setProgress(0)
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
      // Single shared apply path: verifies the published sha256 and fails
      // closed when the manifest has none.
      await downloadAndApplyUpdate({
        manifest,
        updater: CapacitorUpdater,
        onProgress: setProgress,
      })
    } catch (err) {
      setError(err?.message || 'Update failed.')
      setPhase('error')
    }
  }, [manifest])

  const dismiss = useCallback(() => {
    if (manifest) dismissedVersionRef.current = manifest.version
    setOpen(false)
  }, [manifest])

  if (!isNative || !manifest) return null

  const installing = phase === 'installing'
  const nativeRequired = phase === 'native-required'

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{nativeRequired ? 'A new app version is required' : 'Update available'}</DialogTitle>
          <DialogDescription>
            {nativeRequired
              ? `GrantFlow v${manifest.version} needs app version ${manifest.minNativeVersion} or newer. ` +
                'Install the latest GrantFlow app to get it — this update includes changes that an ' +
                'in-app update cannot deliver.'
              : `GrantFlow v${manifest.version} is ready to install.${manifest.notes ? ` ${manifest.notes}` : ''}`}
          </DialogDescription>
        </DialogHeader>

        {phase === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {installing && (
          <div className="space-y-2">
            <Progress value={progress} />
            <p className="text-sm text-slate-500">Downloading and verifying… {Math.round(progress)}%</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={dismiss} disabled={installing}>
            {nativeRequired ? 'Close' : 'Later'}
          </Button>
          {!nativeRequired && (
            <Button onClick={install} disabled={installing}>
              {installing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Install now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
