import React, { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CheckCircle, FileText, Info, Search, Sparkles, X } from 'lucide-react'

function configuredVideoUrl() {
  const value = String(import.meta?.env?.VITE_ONBOARDING_VIDEO_URL || '').trim()
  return /^https?:\/\//i.test(value) ? value : null
}

const WALKTHROUGH_STEPS = Object.freeze([
  {
    icon: Search,
    title: 'Find funding that fits',
    body: 'GrantFlow compares real opportunities with your profile, location, eligibility, and stated needs.',
  },
  {
    icon: FileText,
    title: 'Keep the work together',
    body: 'Save documents and track each application from discovery through submission and follow-up.',
  },
  {
    icon: Sparkles,
    title: 'Ask Anya what comes next',
    body: 'Anya explains matches, identifies missing details, and guides you to the next useful action.',
  },
])

export default function OnboardingVideo({ open, onComplete, onSkip }) {
  const [videoError, setVideoError] = useState(false)
  const [videoUrl] = useState(() => configuredVideoUrl())
  const videoRef = useRef(null)
  const showVideo = Boolean(videoUrl) && !videoError

  useEffect(() => {
    if (open) return
    try {
      videoRef.current?.pause?.()
    } catch {
      // The browser may have already released the media element.
    }
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      active?.blur?.()
    } catch {
      // Focus cleanup is best-effort.
    }
  }, [open])

  const closeWith = (callback) => {
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      active?.blur?.()
    } catch {
      // Focus cleanup is best-effort.
    }
    callback?.()
  }

  const handleComplete = () => closeWith(onComplete)
  const handleSkip = () => closeWith(onSkip)

  const handleVideoError = () => {
    console.warn('[onboarding-video] Configured onboarding video could not be loaded; using the built-in walkthrough.')
    setVideoError(true)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleSkip()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>Welcome to GrantFlow!</DialogTitle>
          <DialogDescription>
            Here is the quick tour: find relevant funding, organize the application work, and ask Anya for guidance at any step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {showVideo ? (
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-900">
              <video
                ref={videoRef}
                controls
                className="h-full w-full"
                onError={handleVideoError}
                tabIndex={-1}
                preload="metadata"
              >
                <source src={videoUrl} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          ) : (
            <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-5 dark:border-blue-900 dark:bg-blue-950/30">
              <div className="mb-4 flex items-start gap-3">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-300" />
                <div>
                  <p className="font-medium text-blue-950 dark:text-blue-100">Your three-step GrantFlow walkthrough</p>
                  <p className="mt-1 text-sm text-blue-900 dark:text-blue-200">
                    Everything needed to begin is here in the app. No video download or external media is required.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {WALKTHROUGH_STEPS.map(({ icon: Icon, title, body }, index) => (
                  <div
                    key={title}
                    className="rounded-lg border border-blue-100 bg-white p-4 shadow-sm dark:border-blue-900 dark:bg-slate-900"
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                        {index + 1}
                      </span>
                      <Icon className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                    </div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleSkip}
            className="flex items-center gap-2"
          >
            <X className="h-4 w-4" />
            Skip for now
          </Button>
          <Button
            type="button"
            onClick={handleComplete}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700"
          >
            <CheckCircle className="h-4 w-4" />
            Continue to GrantFlow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
