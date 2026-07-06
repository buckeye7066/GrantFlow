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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Info, X, CheckCircle } from 'lucide-react'

// The onboarding MP4 is expected to be deployed as a *public* asset.
// README: "Drop the final MP4 into public/Grant Flow_ Get Started.mp4"
//
// IMPORTANT: We must respect Vite's base path (prod uses "/grantflow/"), otherwise we 404.
const VIDEO_FILENAMES = [
  'Grant Flow_ Get Started.mp4',
  // Back-compat (a previous broken filename variant we’ve seen in the wild)
  'Grant Flow_ Get Started. mp4',
]

function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '/').trim() || '/'
  return b.endsWith('/') ? b : b + '/'
}

function buildVideoCandidates() {
  const base = normalizeBaseUrl(import.meta?.env?.BASE_URL)
  const override = String(import.meta?.env?.VITE_ONBOARDING_VIDEO_URL || '').trim()
  const candidates = []
  if (override) candidates.push(override)
  for (const name of VIDEO_FILENAMES) {
    candidates.push(base + encodeURIComponent(name))
  }
  return candidates
}

export default function OnboardingVideo({ open, onComplete, onSkip }) {
  const [videoError, setVideoError] = useState(null)
  const [sourceIndex, setSourceIndex] = useState(0)
  const [candidates] = useState(() => buildVideoCandidates())
  const videoRef = useRef(null)

  // Prevent browser warning: don't allow focus to remain inside a dialog that is being aria-hidden during close.
  useEffect(() => {
    if (open) return
    try {
      videoRef.current?.pause?.()
    } catch {
      // ignore
    }
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      active?.blur?.()
    } catch {
      // ignore
    }
  }, [open])

  const handleComplete = () => {
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      active?.blur?.()
    } catch {
      // ignore
    }
    onComplete?.()
  }

  const handleSkip = () => {
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null
      active?.blur?.()
    } catch {
      // ignore
    }
    onSkip?.()
  }

  const sourceIndexRef = useRef(sourceIndex)
  useEffect(() => {
    sourceIndexRef.current = sourceIndex
  }, [sourceIndex])

  const handleVideoError = () => {
    const currentIndex = sourceIndexRef.current
    const failedSrc = candidates[currentIndex] || null
    console.error('[onboarding-video] Failed to load video source', {
      src: failedSrc,
      base_url: import.meta?.env?.BASE_URL,
      has_override: Boolean(String(import.meta?.env?.VITE_ONBOARDING_VIDEO_URL || '').trim()),
    })

    const nextIndex = currentIndex + 1
    if (nextIndex < candidates.length) {
      sourceIndexRef.current = nextIndex
      setSourceIndex(nextIndex)
      return
    }

    setVideoError({
      message: 'Failed to load onboarding tutorial video.',
      tried: candidates,
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          try {
            const active = typeof document !== 'undefined' ? document.activeElement : null
            active?.blur?.()
          } catch {
            // ignore
          }
          handleSkip()
        }
      }}
    >
      <DialogContent className="sm:max-w-[900px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Welcome to GrantFlow!</DialogTitle>
          <DialogDescription>
            Watch this quick walkthrough to see how GrantFlow finds real funding for you — and how
            Anya, your in-app guide, helps at every step.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {videoError ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <p className="font-medium mb-1">The welcome video couldn't load right now</p>
                <p className="text-sm">
                  No problem — you don't need it to get started. Anya will walk you through
                  everything the video covers. Just continue below.
                </p>
                {import.meta.env.DEV ? (
                  <div className="text-sm space-y-2 mt-3 border-t pt-3">
                    <p className="font-medium">Dev-only details — tried these URL(s):</p>
                    <ul className="list-disc list-inside space-y-1">
                      {(videoError?.tried || []).map((u) => (
                        <li key={u} className="break-all">{u}</li>
                      ))}
                    </ul>
                    <p className="mt-3">
                      Fix by adding the file to <code className="px-1 py-0.5 bg-white/60 rounded">public/Grant Flow_ Get Started.mp4</code> and redeploying,
                      or set <code className="px-1 py-0.5 bg-white/60 rounded">VITE_ONBOARDING_VIDEO_URL</code> to a hosted MP4 URL at build time.
                    </p>
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="relative w-full aspect-video bg-slate-900 rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                controls
                className="w-full h-full"
                onError={handleVideoError}
                tabIndex={-1}
              >
                <source src={candidates[sourceIndex]} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>
          )}

          <div className="mt-4 p-4 bg-blue-50 border border-blue-100 rounded-lg">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-blue-900">
                <p className="font-medium mb-1">What you'll learn:</p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>Finding real funding that matches your situation</li>
                  <li>Tracking the opportunities you're pursuing, from found to submitted</li>
                  <li>Uploading documents so applications can fill themselves in</li>
                  <li>Getting help from Anya, your in-app guide, anytime</li>
                </ul>
              </div>
            </div>
          </div>
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
            Mark as Complete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
