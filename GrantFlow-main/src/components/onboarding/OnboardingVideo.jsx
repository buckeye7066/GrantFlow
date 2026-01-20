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

// Properly encode the video path to handle spaces and special characters in filename
// The path parts are joined to ensure proper encoding while keeping forward slashes
const VIDEO_PATH = '/' + encodeURIComponent('Grant Flow_ Get Started. mp4')

export default function OnboardingVideo({ open, onComplete, onSkip }) {
  const [videoError, setVideoError] = useState(false)
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

  const handleVideoError = () => {
    setVideoError(true)
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
            Watch this quick walkthrough to get started with GrantFlow. Learn about authentication, 
            crawler automation, document ingestion, and the Anya AI assistant.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {videoError ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <p className="font-medium mb-2">Video file not found</p>
                <p className="text-sm">
                  The onboarding video should be placed at <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">public/Grant Flow_ Get Started.mp4</code>
                </p>
                <p className="text-sm mt-2">
                  You can still proceed with using GrantFlow. Check out the documentation for help getting started.
                </p>
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
                <source src={VIDEO_PATH} type="video/mp4" />
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
                  <li>How to authenticate and manage your account</li>
                  <li>Using AI-powered crawlers to find funding opportunities</li>
                  <li>Uploading and processing application documents</li>
                  <li>Working with the Anya AI assistant</li>
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
