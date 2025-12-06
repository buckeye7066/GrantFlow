
import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ProposalCoachPanel from '../proposals/ProposalCoachPanel';
import Checklist from '../workflow/Checklist';
import BudgetTab from '../budgets/BudgetTab';
import DocumentManager from '../documents/DocumentManager'; // NEW IMPORT
import ErrorBoundary from '@/components/shared/ErrorBoundary';

/**
 * Tabs component for grant detail sections
 */
export default function GrantTabs({ 
  grant, 
  activeTab, 
  onTabChange,
  onAnalyze,
  isAnalyzing,
  onStartApplication 
}) {
  return (
    <Tabs value={activeTab} onValueChange={onTabChange}> {/* Removed className from Tabs */}
      <TabsList className="grid w-full grid-cols-6"> {/* Updated className and triggers */}
        <TabsTrigger value="coach">Coach</TabsTrigger>
        <TabsTrigger value="checklist">Checklist</TabsTrigger>
        <TabsTrigger value="requirements">Requirements</TabsTrigger> {/* NEW Trigger */}
        <TabsTrigger value="documents">Documents</TabsTrigger> {/* NEW Trigger */}
        <TabsTrigger value="budget">Budget</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger> {/* NEW Trigger */}
      </TabsList>

      <TabsContent value="coach" className="p-4">
        <ErrorBoundary>
          <ProposalCoachPanel 
            grantId={grant.id}
            grant={grant} 
            onAnalyze={onAnalyze}
            isAnalyzing={isAnalyzing}
            onStartApplication={onStartApplication}
          />
        </ErrorBoundary>
      </TabsContent>

      <TabsContent value="checklist" className="p-4">
        <ErrorBoundary>
          <Checklist grantId={grant.id} organizationId={grant.organization_id} />
        </ErrorBoundary>
      </TabsContent>

      {/* NEW: Requirements Tab - Placeholder as no specific component was provided in the outline */}
      <TabsContent value="requirements" className="p-4">
        <div className="text-gray-500">Requirements content goes here.</div>
      </TabsContent>

      {/* NEW: Documents Tab */}
      <TabsContent value="documents" className="p-4">
        <ErrorBoundary>
          <DocumentManager
            organizationId={grant.organization_id}
            grantId={grant.id}
            mode="full"
          />
        </ErrorBoundary>
      </TabsContent>

      <TabsContent value="budget" className="p-4">
        <ErrorBoundary>
          <BudgetTab grant={grant} />
        </ErrorBoundary>
      </TabsContent>

      {/* NEW: Notes Tab - Placeholder as no specific component was provided in the outline */}
      <TabsContent value="notes" className="p-4">
        <div className="text-gray-500">Notes content goes here.</div>
      </TabsContent>
      
      {/* Existing TabsContent for 'timelogs' and 'compliance' have been removed as per the new TabsList structure */}
    </Tabs>
  );
}
