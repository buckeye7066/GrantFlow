import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';

/**
 * Error state for match failures
 */
export default function MatchError({ error }) {
  return (
    <Alert variant="destructive" role="alert" aria-live="assertive">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}