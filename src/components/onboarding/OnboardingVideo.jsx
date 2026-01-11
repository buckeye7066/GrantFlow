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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Info, X, CheckCircle } from 'lucide-react'

// Properly encode the video path to handle spaces and special characters in filename
// The path parts are joined to ensure proper encoding while keeping forward slashes
const DEFAULT_VIDEO_FILENAME = 'Grant Flow_ Get Started. mp4'
const DEFAULT_VIDEO_PATH = `${import.meta.env.BASE_URL}${encodeURIComponent(DEFAULT_VIDEO_FILENAME)}`
const IS_SMOKE_UI =
  String(import.meta.env.VITE_SMOKE_MODE ?? '').toLowerCase() === 'true' ||
  (typeof globalThis !== 'undefined' && globalThis.__GF_SMOKE__ === true)

// In smoke runs, don't attempt to load a local MP4 by default (it may not be present in build output),
// because a 404 becomes a console error and fails the smoke suite.
const VIDEO_PATH =
  import.meta.env.VITE_ONBOARDING_VIDEO_URL || (IS_SMOKE_UI ? null : DEFAULT_VIDEO_PATH)

export default function OnboardingVideo({ open, onComplete, onSkip }) {
  const [videoError, setVideoError] = useState(IS_SMOKE_UI && !import.meta.env.VITE_ONBOARDING_VIDEO_URL)

  const handleComplete = () => {
    onComplete?.()
  }

  const handleSkip = () => {
    onSkip?.()
  }

  const handleVideoError = () => {
    setVideoError(true)
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleSkip()}>
      <DialogContent className="sm:max-w-[900px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Welcome to GrantFlow!</DialogTitle>
          <DialogDescription>
            Watch this quick walkthrough to get started with GrantFlow. Learn about authentication, 
            crawler automation, document ingestion, and the Anya AI assistant.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {videoError || !VIDEO_PATH ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <p className="font-medium mb-2">Video file not found</p>
                <p className="text-sm">
                  If you want the onboarding video, provide it via <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">VITE_ONBOARDING_VIDEO_URL</code> or place it at{' '}
                  <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">public/{DEFAULT_VIDEO_FILENAME}</code>
                </p>
                <p className="text-sm mt-2">
                  You can still proceed with using GrantFlow. Check out the documentation for help getting started.
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="relative w-full aspect-video bg-slate-900 rounded-lg overflow-hidden">
              <video
                controls
                className="w-full h-full"
                onError={handleVideoError}
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
