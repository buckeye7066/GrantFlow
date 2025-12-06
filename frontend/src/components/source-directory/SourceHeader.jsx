import React from 'react';
import { Target, Building2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * Source Directory page header with title and profile selector
 */
export default function SourceHeader({ 
  organizations, 
  selectedOrgId, 
  onSelectOrg, 
  selectedOrg,
  isLoading 
}) {
  return (
    <div className="mb-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Target className="w-8 h-8 text-blue-600" />
            Source Directory
          </h1>
          <p className="text-slate-600 mt-2">
            Discover and manage local funding sources
          </p>
        </div>

        <div className="w-full md:w-80">
          <Select value={selectedOrgId || ""} onValueChange={onSelectOrg} disabled={isLoading}>
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
      </div>

      {selectedOrg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-900">
            <strong>📂 Showing sources for:</strong>{' '}
            <span className="font-semibold">{selectedOrg.name}</span>
            {selectedOrg.applicant_type && (
              <span className="ml-2 text-xs">
                ({selectedOrg.applicant_type.replace(/_/g, ' ')})
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}