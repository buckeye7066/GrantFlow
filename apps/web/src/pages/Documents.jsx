import React, { useState, useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Loader2, FolderOpen } from 'lucide-react';
import DocumentManager from '@/components/documents/DocumentManager';
import { useRLSOrganizations } from '@/components/hooks/useAuthRLS';

const LS_KEY = 'documents:last_org_id';

/**
 * Documents Page - Standalone document management
 * Full-featured document library for all organizations
 */
export default function DocumentsPage() {
  const [selectedOrgId, setSelectedOrgId] = useState('');

  // RLS-safe organizations query
  const { 
    data: organizations = [], 
    isLoading: isLoadingOrgs, 
    isLoadingUser 
  } = useRLSOrganizations();

  // Initialize selection from localStorage or first org; heal if selection disappears
  useEffect(() => {
    if (isLoadingUser || isLoadingOrgs) return;

    const ids = organizations.map((o) => String(o.id));
    if (ids.length === 0) {
      if (selectedOrgId) setSelectedOrgId('');
      return;
    }

    // If current selection is present, keep it
    if (selectedOrgId && ids.includes(String(selectedOrgId))) return;

    // Try restore last selection
    const saved = localStorage.getItem(LS_KEY);
    if (saved && ids.includes(saved)) {
      setSelectedOrgId(saved);
      return;
    }

    // Fallback to the first org
    setSelectedOrgId(ids[0]);
  }, [organizations, isLoadingUser, isLoadingOrgs, selectedOrgId]);

  // Persist selection
  useEffect(() => {
    if (selectedOrgId) {
      localStorage.setItem(LS_KEY, String(selectedOrgId));
    }
  }, [selectedOrgId]);

  if (isLoadingUser || isLoadingOrgs) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <FolderOpen className="w-8 h-8 text-blue-600" />
            Document Library
          </h1>
          <p className="text-slate-600 mt-2">
            Centralized grant document storage
          </p>
        </div>

        {/* Organization Selector */}
        <div className="mb-6">
          <Label className="mb-2 block">Select Organization</Label>
          <Select value={String(selectedOrgId)} onValueChange={(v) => setSelectedOrgId(String(v))}>
            <SelectTrigger className="max-w-md mt-2" aria-label="Choose organization">
              <SelectValue placeholder="Choose organization..." />
            </SelectTrigger>
            <SelectContent>
              {organizations.map((org) => (
                <SelectItem key={org.id} value={String(org.id)}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Document Manager */}
        {selectedOrgId ? (
          <DocumentManager
            organizationId={selectedOrgId}
            mode="full"
          />
        ) : (
          <div className="text-center py-12 border border-dashed border-slate-300 rounded-lg">
            <FolderOpen className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <p className="text-slate-600">Select an organization to view documents</p>
          </div>
        )}
      </div>
    </div>
  );
}