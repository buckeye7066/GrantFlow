import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

export default function AutoAdvanceRunner() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Auto-Advance Runner</CardTitle>
        </CardHeader>
        <CardContent className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-slate-600">This page is deprecated. Auto-advance now runs on the Dashboard.</p>
        </CardContent>
      </Card>
    </div>
  );
}