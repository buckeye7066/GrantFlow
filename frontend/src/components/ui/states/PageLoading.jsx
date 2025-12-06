import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Full-page loading indicator
 */
export default function PageLoading({ label = 'Loading...' }) {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <Loader2 className="w-12 h-12 animate-spin text-slate-400 mx-auto" />
        <p className="mt-4 text-slate-600">{label}</p>
      </div>
    </div>
  );
}