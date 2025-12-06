import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import StatusBadge from './StatusBadge';

/**
 * Individual crawler card with run button
 */
export default function CrawlerCard({ 
  crawler, 
  latestLog, 
  isCrawling, 
  onRun 
}) {
  return (
    <Card className={`shadow-lg border-0 ${isCrawling ? 'bg-amber-50 border-amber-200 border-2' : ''}`}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <span className="text-2xl">{crawler.icon}</span>
              {crawler.name}
              {crawler.needsProfile && (
                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                  profile-aware
                </Badge>
              )}
              <StatusBadge 
                status={latestLog?.status} 
                isCrawling={isCrawling} 
              />
            </CardTitle>
            <CardDescription className="mt-2">{crawler.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-slate-500">Records Found</p>
            <p className="text-2xl font-bold text-slate-900">
              {latestLog?.recordsFound || 0}
            </p>
          </div>
          <div>
            <p className="text-sm text-slate-500">Records Added</p>
            <p className="text-2xl font-bold text-emerald-600">
              {latestLog?.recordsAdded || 0}
            </p>
          </div>
        </div>

        {latestLog?.created_date && (
          <p className="text-xs text-slate-500">
            Last crawled: {format(new Date(latestLog.created_date), 'MMM d, yyyy h:mm a')}
          </p>
        )}

        {latestLog?.errorMessage && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-xs text-red-700">{latestLog.errorMessage}</p>
          </div>
        )}

        <Button
          onClick={() => onRun(crawler)}
          className="w-full bg-blue-600 hover:bg-blue-700"
          disabled={isCrawling}
        >
          {isCrawling ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" />
              Run Crawler
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}