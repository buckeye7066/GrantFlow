import React, { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, FolderOpen } from 'lucide-react';
import DocumentManager from '@/components/documents/DocumentManager';
import { useRLSOrganizations } from '@/components/hooks/useAuthRLS';

export default function DocumentsPage() {
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const { data: organizations = [], isLoading } = useRLSOrganizations();

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2 mb-8">
          <FolderOpen className="w-8 h-8 text-blue-600" />
          Document Library
        </h1>
        <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
          <SelectTrigger className="max-w-md mb-6">
            <SelectValue placeholder="Select organization..." />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((org) => (
              <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedOrgId && <DocumentManager organizationId={selectedOrgId} mode="full" />}
      </div>
    </div>
  );
}