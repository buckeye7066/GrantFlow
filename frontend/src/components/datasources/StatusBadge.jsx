import React from 'react';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, AlertCircle, Clock } from 'lucide-react';

/**
 * Status badge for crawl logs
 */
export default function StatusBadge({ status, isCrawling = false }) {
  if (isCrawling) {
    return (
      <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
        <Clock className="w-3 h-3 mr-1 animate-pulse" />
        crawling...
      </Badge>
    );
  }

  if (status === 'completed') {
    return (
      <Badge className="bg-green-100 text-green-700 border-green-200">
        <CheckCircle className="w-3 h-3 mr-1" />
        completed
      </Badge>
    );
  }

  if (status === 'failed') {
    return (
      <Badge variant="destructive">
        <AlertCircle className="w-3 h-3 mr-1" />
        failed
      </Badge>
    );
  }

  return null;
}