import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertCircle } from 'lucide-react';
import { format } from 'date-fns';

/**
 * Display recent crawl activity logs
 */
export default function RecentCrawlActivity({ crawlLogs }) {
  if (crawlLogs.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <div className="text-center py-12 text-slate-500">
            <AlertCircle className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No crawl activity yet.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="divide-y">
          {crawlLogs.slice(0, 10).map(log => (
            <div key={log.id} className="p-4 hover:bg-slate-50 transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-slate-900">
                      {log.source.replace(/_/g, '.')}
                    </p>
                    <Badge
                      variant="outline"
                      className={
                        log.status === 'completed'
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : log.status === 'failed'
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }
                    >
                      {log.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-slate-600">
                    {log.created_date && format(new Date(log.created_date), 'MMM d, yyyy h:mm a')}
                  </p>
                  {log.errorMessage && (
                    <p className="text-sm text-red-600 mt-2">
                      Error: {log.errorMessage}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm text-slate-500">Found: {log.recordsFound || 0}</p>
                  <p className="text-sm font-semibold text-emerald-600">
                    Added: {log.recordsAdded || 0}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}