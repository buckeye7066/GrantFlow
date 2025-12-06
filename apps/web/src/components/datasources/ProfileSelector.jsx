import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Building2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Profile selector with context display
 */
export default function ProfileSelector({ 
  value, 
  onChange, 
  organizations, 
  selectedOrg,
  disabled 
}) {
  const isECF = selectedOrg?.medicaid_enrolled && selectedOrg?.medicaid_waiver_program === 'ecf_choices';

  return (
    <div>
      <div className="w-full md:w-80">
        <Select value={value || ""} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-500" />
              <SelectValue placeholder="Select a profile..." />
            </div>
          </SelectTrigger>
          <SelectContent>
            {organizations.map(org => (
              <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedOrg && (
        <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-900">
            <strong>🎯 Crawling for:</strong>{' '}
            <span className="font-semibold">{selectedOrg.name}</span>
            {selectedOrg.applicant_type && (
              <span className="ml-2 text-xs">
                ({selectedOrg.applicant_type.replace(/_/g, ' ')})
              </span>
            )}
            {' '}— Profile-aware crawlers will search for opportunities relevant to this profile.
          </p>
        </div>
      )}
    </div>
  );
}