import { useEffect } from 'react'

export default function NativeBootReady() {
  useEffect(() => {
    let stopped = false
    import('@capacitor/core').then(async ({ Capacitor }) => {
      if (stopped || !Capacitor.isNativePlatform()) return
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
      if (!stopped) await CapacitorUpdater.notifyAppReady()
    }).catch(() => {})
    return () => { stopped = true }
  }, [])
  return null
}
