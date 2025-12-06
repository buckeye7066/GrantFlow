import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Loading state for match calculation
 */
export default function MatchLoading() {
  return (
    <div className="text-center py-16" role="status" aria-live="polite">
      <Loader2 className="w-12 h-12 mx-auto text-purple-600 mb-4 animate-spin" />
      <h3 className="text-xl font-semibold text-slate-800">Analyzing Grant Matches...</h3>
      <p className="text-slate-600 mt-2">
        Using AI to calculate compatibility scores for each grant in your pipeline.
      </p>
    </div>
  );
}