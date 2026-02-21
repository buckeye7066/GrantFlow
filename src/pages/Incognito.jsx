import { useSettingsStore } from '@/stores/settingsStore'
import { Navigate } from 'react-router-dom'

export default function Incognito() {
  const preferences = useSettingsStore((state) => state.preferences)
  const enabled = preferences?.custom_preferences?.incognitoEnabled ?? false
  if (!enabled) {
    // If the module is disabled, redirect to dashboard
    return <Navigate to="/Dashboard" replace />
  }
  return (
    <div className="container max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold mb-4">Incognito</h1>
      <p>This module is currently under development. Check back soon.</p>
    </div>
  )
}
