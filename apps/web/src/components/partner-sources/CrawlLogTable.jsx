import React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CheckCircle, XCircle } from 'lucide-react';
import { getRelativeTime } from '@/components/shared/dateHelpers';

/**
 * Table displaying crawl job logs
 */
export default function CrawlLogTable({ crawlLogs }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source / Job</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Records Found</TableHead>
          <TableHead>Timestamp</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {crawlLogs.map(log => (
          <TableRow key={log.id}>
            <TableCell className="font-medium">{log.source}</TableCell>
            <TableCell>
              {log.status === 'completed' ? (
                <CheckCircle className="w-5 h-5 text-emerald-500" />
              ) : (
                <XCircle className="w-5 h-5 text-red-500" />
              )}
            </TableCell>
            <TableCell>{log.recordsFound}</TableCell>
            <TableCell>{getRelativeTime(log.created_date)} ago</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}