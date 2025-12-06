import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, AlertTriangle, FileText, DollarSign, Building2, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Review Step - Final review before submission
 */
export default function ReviewStep({ data, grant, organization }) {
  const totalBudget = (data.budget_items || []).reduce((sum, item) => 
    sum + (parseFloat(item.total) || 0), 0
  );

  const completionChecks = [
    {
      label: 'Project Title',
      completed: !!data.project_title,
      value: data.project_title
    },
    {
      label: 'Requested Amount',
      completed: !!data.requested_amount,
      value: data.requested_amount ? `$${parseFloat(data.requested_amount).toLocaleString()}` : ''
    },
    {
      label: 'Problem Statement',
      completed: !!data.problem_statement,
      value: data.problem_statement ? `${data.problem_statement.substring(0, 100)}...` : ''
    },
    {
      label: 'Project Goals',
      completed: !!data.project_goals,
      value: data.project_goals ? `${data.project_goals.substring(0, 100)}...` : ''
    },
    {
      label: 'Budget Items',
      completed: (data.budget_items || []).length > 0,
      value: `${(data.budget_items || []).length} line items, $${totalBudget.toLocaleString()} total`
    },
    {
      label: 'Organization Info',
      completed: !!data.organization_name,
      value: data.organization_name
    }
  ];

  const completedCount = completionChecks.filter(c => c.completed).length;
  const allComplete = completedCount === completionChecks.length;

  return (
    <div className="space-y-6">
      {/* Completion Status */}
      {allComplete ? (
        <Alert className="bg-green-50 border-green-300">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-900">
            <strong>🎉 Application Complete!</strong>
            <p className="text-sm mt-1">
              All required sections are filled out. Review the details below and click "Complete Application" when ready.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="bg-amber-50 border-amber-300">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-900">
            <strong>⚠️ Some Sections Incomplete</strong>
            <p className="text-sm mt-1">
              {completedCount} of {completionChecks.length} required sections completed. 
              Review incomplete sections before submitting.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Completion Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            Application Checklist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {completionChecks.map((check, index) => (
              <div key={index} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50">
                {check.completed ? (
                  <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                )}
                <div className="flex-1">
                  <p className="font-medium text-slate-900">{check.label}</p>
                  {check.value && (
                    <p className="text-sm text-slate-600 mt-1">{check.value}</p>
                  )}
                </div>
                <Badge variant={check.completed ? 'default' : 'outline'}>
                  {check.completed ? 'Complete' : 'Missing'}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Application Summary */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Basic Info Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Basic Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-slate-600">Project Title</p>
              <p className="font-medium text-slate-900">{data.project_title || 'Not specified'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-600">Requested Amount</p>
              <p className="font-medium text-slate-900">
                {data.requested_amount ? `$${parseFloat(data.requested_amount).toLocaleString()}` : 'Not specified'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600">Project Period</p>
              <p className="font-medium text-slate-900">
                {data.project_start_date && data.project_end_date
                  ? `${data.project_start_date} to ${data.project_end_date}`
                  : 'Not specified'}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Organization Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              Organization
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-slate-600">Organization Name</p>
              <p className="font-medium text-slate-900">{data.organization_name || organization?.name}</p>
            </div>
            <div>
              <p className="text-xs text-slate-600">EIN</p>
              <p className="font-medium text-slate-900">{data.organization_ein || organization?.ein || 'N/A'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-600">Location</p>
              <p className="font-medium text-slate-900">
                {data.organization_city || organization?.city}, {data.organization_state || organization?.state}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Budget Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Budget
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-slate-600">Total Budget</p>
              <p className="font-bold text-slate-900 text-xl">${totalBudget.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-slate-600">Budget Line Items</p>
              <p className="font-medium text-slate-900">
                {(data.budget_items || []).length} items
              </p>
            </div>
            {data.indirect_rate && (
              <div>
                <p className="text-xs text-slate-600">Indirect Rate</p>
                <p className="font-medium text-slate-900">{data.indirect_rate}%</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attachments Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Paperclip className="w-4 h-4" />
              Attachments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <p className="text-sm text-slate-600">
                {data.attachments?.length || 0} document(s) attached
              </p>
              {data.attachments && data.attachments.length > 0 && (
                <div className="space-y-1">
                  {data.attachments.map((file, idx) => (
                    <div key={idx} className="text-xs text-slate-700 flex items-center gap-2">
                      <Paperclip className="w-3 h-3" />
                      {file.name || `Attachment ${idx + 1}`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Final Review Notice */}
      <Alert>
        <FileText className="h-4 w-4" />
        <AlertDescription>
          <strong>📋 Next Steps:</strong>
          <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
            <li>Review all sections for accuracy and completeness</li>
            <li>Ensure all required documents are uploaded</li>
            <li>Have someone else review your application if possible</li>
            <li>Check the grant portal/submission instructions</li>
            <li>Submit before the deadline: <strong>{grant?.deadline}</strong></li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}