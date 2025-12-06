import React from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader2 } from 'lucide-react';

/**
 * Error state display for profile loading failures
 * Provides retry options and helpful messaging
 */
const noop = () => {};

export default function ProfileLoadingError({
  onRetry = noop,
  onWaitAndRetry = noop,
  onBack = noop,
}) {
  return (
    <div
      className="flex flex-col justify-center items-center h-full min-h-[400px] p-4 text-center gap-4"
      role="region"
      aria-label="Profile loading error"
    >
      <div
        className="p-4 bg-red-50 rounded-lg border border-red-200 max-w-lg"
        role="alert"
        aria-live="assertive"
      >
        <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-3" aria-hidden="true" />
        <h3 className="text-lg font-semibold text-red-900 mb-2">
          Profile Not Found
        </h3>
        <p className="text-red-700 mb-2">
          The profile couldn&apos;t be loaded at this time.
        </p>
        <p className="text-sm text-red-600 mb-4">
          This might happen if:
        </p>
        <ul className="text-left text-sm text-red-600 mt-2 space-y-1 ml-4" role="list">
          <li>• The profile was just created and needs a moment to sync</li>
          <li>• There was a temporary connection issue</li>
          <li>• The profile ID is incorrect</li>
        </ul>

        <div className="flex gap-3 justify-center flex-wrap mt-6">
          <Button
            onClick={onRetry}
            className="bg-blue-600 hover:bg-blue-700"
            aria-label="Try loading the profile again"
            title="Try Again"
          >
            <Loader2 className="w-4 h-4 mr-2" aria-hidden="true" />
            Try Again
          </Button>
          <Button
            onClick={onWaitAndRetry}
            variant="outline"
            className="border-blue-600 text-blue-600 hover:bg-blue-50"
            aria-label="Wait three seconds and retry loading the profile"
            title="Wait & Retry (3s)"
          >
            Wait & Retry (3s)
          </Button>
          <Button
            onClick={onBack}
            variant="outline"
            aria-label="Back to profiles list"
            title="Back to Profiles"
          >
            ← Back to Profiles
          </Button>
        </div>
      </div>
    </div>
  );
}