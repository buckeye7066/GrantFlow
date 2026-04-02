/**
 * First-run onboarding wizard.
 * Appears when: 0 profiles OR active profile missing zip/state.
 * Persists to backend; Skip still requires profile selection before search.
 */
import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, ChevronRight, ChevronLeft } from 'lucide-react'
import { apiFetch } from '@/api/client'
import { useToast } from '@/components/ui/use-toast'
import { useQueryClient } from '@tanstack/react-query'
import { upsertProfileSection } from '@/api/profiles'
import { messages } from '@/i18n/messages.en'

const LOOKING_FOR_OPTIONS = [
  { value: 'scholarships', label: messages.lookingForOptions.scholarships },
  { value: 'emergency_help', label: messages.lookingForOptions.emergency_help },
  { value: 'disability', label: messages.lookingForOptions.disability },
  { value: 'ministry_nonprofit', label: messages.lookingForOptions.ministry_nonprofit },
  { value: 'medical', label: messages.lookingForOptions.medical },
  { value: 'general', label: messages.lookingForOptions.general },
]

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]

export default function FirstRunOnboardingWizard({ open, onComplete, onSkip, profiles = [], activeProfileId }) {
  const [step, setStep] = useState(1)
  const [formData, setFormData] = useState({
    zip: '',
    state: '',
    looking_for: 'general',
    display_name: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const activeProfile = activeProfileId
    ? profiles.find((p) => String(p.id) === String(activeProfileId))
    : profiles[0]

  const handleSkip = async () => {
    setLoading(true)
    setError(null)
    try {
      const custom = (await apiFetch('/api/preferences'))?.custom_preferences ?? {}
      await apiFetch('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          custom_preferences: { ...custom, onboarding_wizard_skipped: true },
        }),
      })
      queryClient.invalidateQueries({ queryKey: ['userPreferences'] })
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      onSkip?.()
    } catch (err) {
      setError(err?.message ?? 'Could not save. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleComplete = async () => {
    const zip = String(formData.zip || '').trim()
    const state = String(formData.state || '').trim().toUpperCase()
    if (!zip || !state) {
  setError('ZIP and State are required.')
  return
}
if (!/^\d{5}(-\d{4})?$/.test(zip)) {
  setError('ZIP must be a valid 5-digit (or ZIP+4) US postal code.')
  return
}
if (state.length !== 2) {
  setError('State must be a 2-letter abbreviation (e.g., TN).')
  return
}

    setLoading(true)
    setError(null)
    try {
      let profileId = activeProfile?.id

      if (!profileId) {
        const name = formData.display_name?.trim() || 'My Profile'
        const inferredType =
  formData.looking_for === 'ministry_nonprofit' ? 'nonprofit'
  : formData.looking_for === 'scholarships' ? 'student'
  : formData.looking_for === 'disability' ? 'individual_disability'
  : formData.looking_for === 'emergency_help' ? 'individual_emergency'
  : formData.looking_for === 'medical' ? 'individual_medical'
  : 'individual'
        const created = await apiFetch('/api/profiles', {
  method: 'POST',
  body: JSON.stringify({
    display_name: name,
    primary_type: inferredType,
    zip: zip,
    state: state,
    tags: formData.looking_for ? [formData.looking_for] : [],
  }),
})
profileId = created?.id
if (!profileId) throw new Error('Failed to create profile')
      }

      let basicData = { zip, state }
      if (formData.display_name?.trim()) basicData.full_name = formData.display_name.trim()
      if (activeProfile?.id && profileId) {
        try {
          const existing = await apiFetch(`/api/profiles/${profileId}/sections/basic_information`)
          if (existing?.data && typeof existing.data === 'object') {
            basicData = { ...existing.data, ...basicData }
          }
        } catch (_) { /* section may not exist */ }
      }
      await upsertProfileSection(profileId, 'basic_information', basicData, 'onboarding-wizard')

      const custom = (await apiFetch('/api/preferences'))?.custom_preferences ?? {}
      // Write looking_for intent into the profile tags so match engine and crawlers can use it
      if (formData.looking_for && formData.looking_for !== 'general') {
        try {
          await apiFetch(`/api/profiles/${profileId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              tags: [formData.looking_for],
            }),
          })
        } catch (_intentErr) {
          // non-fatal: preference still recorded below
        }
      }

      await apiFetch('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          custom_preferences: {
            ...custom,
            onboarding_wizard_completed: true,
            looking_for_intent: formData.looking_for,
          },
        }),
      })

      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      queryClient.invalidateQueries({ queryKey: ['profile', profileId] })
      queryClient.invalidateQueries({ queryKey: ['userPreferences'] })
      queryClient.invalidateQueries({ queryKey: ['preferences'] })

      toast({ title: 'Profile updated', description: "You're ready to search for funding." })
      onComplete?.({ profileId })
    } catch (err) {
      setError(err?.message ?? 'Could not save. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const canProceed = step === 1 || (step === 2 && formData.zip?.trim() && formData.state?.trim())

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[480px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{step === 1 ? messages.onboardingStep1Title : step === 2 ? messages.onboardingStep2Title : messages.onboardingStep3Title}</DialogTitle>
          <DialogDescription>
            {step === 1 && messages.onboardingStep1Description}
            {step === 2 && messages.onboardingStep2Description}
            {step === 3 && messages.onboardingStep3Description}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              We match grants to your location, situation, and goals. Adding your ZIP and state helps us find local opportunities.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 py-4">
            {profiles.length === 0 && (
              <div className="grid gap-2">
                <Label htmlFor="display_name">Profile name (optional)</Label>
                <Input
                  id="display_name"
                  placeholder="e.g., My Profile"
                  value={formData.display_name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, display_name: e.target.value }))}
                />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="zip">{messages.zipCode} *</Label>
              <Input
                id="zip"
                placeholder="12345"
                maxLength={10}
                value={formData.zip}
                onChange={(e) => setFormData((prev) => ({ ...prev, zip: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="state">{messages.state} *</Label>
              <Select value={formData.state} onValueChange={(v) => setFormData((prev) => ({ ...prev, state: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="looking_for">{messages.lookingFor}</Label>
              <Select value={formData.looking_for} onValueChange={(v) => setFormData((prev) => ({ ...prev, looking_for: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOKING_FOR_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              {formData.zip} {formData.state} · {LOOKING_FOR_OPTIONS.find((o) => o.value === formData.looking_for)?.label ?? formData.looking_for}
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={handleSkip} disabled={loading}>
            {messages.skipForNow}
          </Button>
          {step === 1 && (
            <Button onClick={() => setStep(2)}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={!canProceed}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="outline" onClick={() => setStep(2)}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleComplete} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {messages.confirmAndSave}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
