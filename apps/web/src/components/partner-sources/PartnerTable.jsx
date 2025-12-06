import React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Loader2, Play, Edit, Trash2 } from 'lucide-react';
import { getRelativeTime } from '@/components/shared/dateHelpers';
import HealthStatusBadge from './HealthStatusBadge';

/**
 * Table displaying partner sources with actions
 */
export default function PartnerTable({ 
  partners, 
  onEdit, 
  onDelete, 
  onRunFeed, 
  isRunningFeed, 
  runFeedPartnerId 
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Partner</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last Success</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {partners.map(partner => (
          <TableRow key={partner.id}>
            <TableCell className="font-medium">{partner.name}</TableCell>
            <TableCell>{partner.org_type}</TableCell>
            <TableCell>
              <HealthStatusBadge status={partner.status} />
            </TableCell>
            <TableCell>
              {partner.last_success_at 
                ? `${getRelativeTime(partner.last_success_at)} ago` 
                : 'Never'}
            </TableCell>
            <TableCell className="flex gap-1">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => onRunFeed(partner.id)} 
                disabled={isRunningFeed && runFeedPartnerId === partner.id}
                title="Run feed for this partner"
              >
                {isRunningFeed && runFeedPartnerId === partner.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => onEdit(partner)}
                title="Edit partner"
              >
                <Edit className="w-4 h-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => onDelete(partner.id)}
                title="Delete partner"
              >
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}