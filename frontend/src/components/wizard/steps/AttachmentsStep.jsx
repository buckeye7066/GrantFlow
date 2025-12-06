import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2, CheckCircle2, AlertCircle, FolderOpen, Download, ExternalLink, FileText } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import DocumentManager from '../../documents/DocumentManager';

/**
 * Attachments Step - Upload required documents
 * Now integrated with full Document Manager and AI suggestions
 * Checks wizard form data to recognize already-completed sections
 */
export default function AttachmentsStep({ data, onChange, grant, organization, formData }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionsData, setSuggestionsData] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const { toast } = useToast();

  // Fetch grant documents
  const { data: grantDocuments = [] } = useQuery({
    queryKey: ['grantDocuments', grant?.id],
    queryFn: () => base44.entities.Document.filter({ grant_id: grant.id }),
    enabled: !!grant?.id
  });

  // Check what sections are already completed in the wizard form
  const getCompletedSections = () => {
    const completed = [];
    const wizardData = formData || data || {};
    
    // Check Basic Information
    if (wizardData.project_title || wizardData.project_summary) {
      completed.push('basic_info', 'project_summary');
    }
    
    // Check Project Narrative
    if (wizardData.need_statement || wizardData.project_description || wizardData.goals_objectives) {
      completed.push('need_statement', 'project_narrative', 'goals_objectives');
    }
    
    // Check Budget
    if (wizardData.budget_items?.length > 0 || wizardData.total_budget || wizardData.budget_narrative) {
      completed.push('budget', 'budget_narrative');
    }
    
    // Check Organization Details
    if (wizardData.organization_history || wizardData.org_capacity || organization?.mission) {
      completed.push('organization_info', 'organizational_capacity');
    }
    
    // Check Eligibility
    if (wizardData.eligibility_confirmation || grant?.eligibility_summary) {
      completed.push('eligibility');
    }
    
    return completed;
  };

  // Get AI suggestions and extract download links
  const handleGetSuggestions = async () => {
    setLoadingSuggestions(true);
    
    try {
      const completedSections = getCompletedSections();
      
      const response = await base44.functions.invoke('suggestDocumentsForGrant', {
        grant_id: grant.id,
        organization_id: organization.id,
        extract_download_links: true,
        completed_wizard_sections: completedSections,
        check_application_availability: true // Verify application is open
      });

      // Filter out suggestions for items already completed in wizard
      let filteredData = response.data;
      if (filteredData.suggestions && completedSections.length > 0) {
        const docTypesToMarkComplete = [];
        
        if (completedSections.includes('need_statement')) {
          docTypesToMarkComplete.push('need_statement', 'needs_assessment');
        }
        if (completedSections.includes('project_narrative')) {
          docTypesToMarkComplete.push('project_narrative', 'project_description', 'proposal');
        }
        if (completedSections.includes('budget') || completedSections.includes('budget_narrative')) {
          docTypesToMarkComplete.push('budget', 'budget_narrative', 'budget_justification');
        }
        if (completedSections.includes('goals_objectives')) {
          docTypesToMarkComplete.push('goals', 'objectives', 'logic_model');
        }
        if (completedSections.includes('organization_info')) {
          docTypesToMarkComplete.push('organizational_capacity', 'org_capacity');
        }
        if (completedSections.includes('eligibility')) {
          docTypesToMarkComplete.push('eligibility');
        }
        
        // Mark matching suggestions as completed in wizard
        filteredData.suggestions = filteredData.suggestions.map(suggestion => {
          const docName = (suggestion.document_name || '').toLowerCase();
          const docType = (suggestion.document_type || '').toLowerCase();
          
          const isCompletedInWizard = docTypesToMarkComplete.some(type => 
            docName.includes(type) || docType.includes(type)
          );
          
          if (isCompletedInWizard && suggestion.status === 'missing') {
            return {
              ...suggestion,
              status: 'completed_in_wizard',
              reason: `✅ Already completed in wizard: ${suggestion.reason}`
            };
          }
          return suggestion;
        });
        
        // Recalculate missing counts
        const stillMissing = filteredData.suggestions.filter(s => s.status === 'missing');
        const requiredMissing = stillMissing.filter(s => s.required);
        
        filteredData.missing_documents = stillMissing.length;
        filteredData.required_missing = requiredMissing.length;
        
        // Recalculate readiness score
        const totalRequired = filteredData.suggestions.filter(s => s.required).length;
        const completedRequired = totalRequired - requiredMissing.length;
        const totalOptional = filteredData.suggestions.filter(s => !s.required).length;
        const completedOptional = totalOptional - stillMissing.filter(s => !s.required).length;
        
        const requiredScore = totalRequired > 0 ? (completedRequired / totalRequired) * 70 : 70;
        const optionalScore = totalOptional > 0 ? (completedOptional / totalOptional) * 30 : 30;
        filteredData.readiness_score = Math.round(requiredScore + optionalScore);
        
        // Update next steps
        if (stillMissing.length === 0) {
          filteredData.next_steps = [
            'All required documents are ready or completed in wizard',
            'Review all documents for accuracy',
            'Proceed with application submission'
          ];
        }
      }

      setSuggestionsData(filteredData);
      setShowSuggestions(true);

      const actualMissing = filteredData.missing_documents || 0;
      toast({
        title: '✨ Suggestions Ready',
        description: actualMissing > 0 
          ? `Found ${actualMissing} document${actualMissing !== 1 ? 's' : ''} still needed${filteredData.downloadable_forms > 0 ? ` (${filteredData.downloadable_forms} forms available)` : ''}`
          : 'All required information is complete! 🎉',
        duration: 6000,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Suggestion Failed',
        description: error.message,
      });
    } finally {
      setLoadingSuggestions(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Instructions and AI Button */}
      <Card className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-slate-900 font-semibold mb-2">
                📎 Upload Supporting Documents
              </p>
              <p className="text-sm text-slate-700">
                Upload all required documents for your grant application. Our AI will analyze grant requirements and suggest what you need.
              </p>
            </div>
            <Button
              onClick={handleGetSuggestions}
              disabled={loadingSuggestions}
              className="bg-purple-600 hover:bg-purple-700 shrink-0"
            >
              {loadingSuggestions ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  AI Suggestions
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Application Not Yet Open Warning */}
      {suggestionsData?.application_availability?.application_status === 'not_yet_open' && (
        <Alert className="border-2 border-amber-500 bg-amber-50">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="ml-2">
            <div className="space-y-2">
              <p className="font-semibold text-amber-900">
                ⏳ Application Not Yet Open
              </p>
              <p className="text-sm text-amber-800">
                {suggestionsData.application_availability.status_message}
              </p>
              {suggestionsData.application_availability.opens_date && (
                <p className="text-sm text-amber-700">
                  <strong>Expected to open:</strong> {suggestionsData.application_availability.opens_date}
                </p>
              )}
              <p className="text-sm text-amber-700">
                ✅ You will be automatically notified when the application opens.
              </p>
              {suggestionsData.application_availability.contact_email && (
                <p className="text-sm text-amber-700">
                  <strong>Contact:</strong> {suggestionsData.application_availability.contact_email}
                </p>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Application Closed Warning */}
      {suggestionsData?.application_availability?.application_status === 'closed' && (
        <Alert className="border-2 border-red-500 bg-red-50">
          <AlertCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="ml-2">
            <div className="space-y-2">
              <p className="font-semibold text-red-900">
                ❌ Application Closed
              </p>
              <p className="text-sm text-red-800">
                {suggestionsData.application_availability.status_message || 'This application period has ended.'}
              </p>
              <p className="text-sm text-red-700">
                Check for future application cycles or similar opportunities.
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Readiness Score */}
      {suggestionsData && (
        <Card className={`border-2 ${
          suggestionsData.readiness_score >= 80 ? 'border-green-500 bg-green-50' :
          suggestionsData.readiness_score >= 50 ? 'border-amber-500 bg-amber-50' :
          'border-red-500 bg-red-50'
        }`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 mb-1">Application Readiness</p>
                <div className="flex items-center gap-3">
                  <div className="text-4xl font-bold text-slate-900">
                    {suggestionsData.readiness_score}%
                  </div>
                  {suggestionsData.readiness_score >= 80 ? (
                    <CheckCircle2 className="w-8 h-8 text-green-600" />
                  ) : suggestionsData.readiness_score >= 50 ? (
                    <AlertCircle className="w-8 h-8 text-amber-600" />
                  ) : (
                    <AlertCircle className="w-8 h-8 text-red-600" />
                  )}
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-600">Missing</p>
                <p className="text-2xl font-bold text-slate-900">
                  {suggestionsData.missing_documents}
                </p>
                <p className="text-xs text-slate-500">
                  ({suggestionsData.required_missing} required)
                </p>
              </div>
            </div>

            {/* Next Steps */}
            {suggestionsData.next_steps && suggestionsData.next_steps.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <p className="text-sm font-semibold text-slate-900 mb-2">Next Steps:</p>
                <ul className="space-y-1">
                  {suggestionsData.next_steps.map((step, idx) => (
                    <li key={idx} className="text-sm text-slate-700 flex items-start gap-2">
                      <span className="text-blue-600 font-bold">{idx + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Downloadable Forms from Funder */}
      {showSuggestions && suggestionsData && suggestionsData.downloadable_forms_list && suggestionsData.downloadable_forms_list.length > 0 && (
        <Card className="border-blue-200 bg-blue-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Download className="w-4 h-4 text-blue-600" />
              Downloadable Forms from Funder
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestionsData.downloadable_forms_list.map((form, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 bg-white rounded-lg border">
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{form.name}</p>
                    {form.description && (
                      <p className="text-xs text-slate-600">{form.description}</p>
                    )}
                  </div>
                </div>
                {form.url ? (
                  <a
                    href={form.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    Download
                  </a>
                ) : (
                  <Badge variant="outline" className="text-slate-500">
                    Link not found
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* AI Suggestions Display */}
      {showSuggestions && suggestionsData && (
        <DocumentManager
          organizationId={organization.id}
          grantId={grant.id}
          mode="suggestions"
        />
      )}

      {/* Current Documents Count */}
      <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-slate-900">
            {grantDocuments.length} Document{grantDocuments.length !== 1 ? 's' : ''} Attached
          </span>
        </div>
        <Button
          onClick={() => setShowSuggestions(false)}
          variant="outline"
          size="sm"
        >
          <FolderOpen className="w-4 h-4 mr-2" />
          Manage All Documents
        </Button>
      </div>

      {/* Full Document Manager */}
      {!showSuggestions && (
        <DocumentManager
          organizationId={organization.id}
          grantId={grant.id}
          mode="full"
        />
      )}
    </div>
  );
}