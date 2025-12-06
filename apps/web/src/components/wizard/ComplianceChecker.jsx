import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import {
  Shield,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  TrendingUp,
  FileWarning,
  Sparkles
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

/**
 * ComplianceChecker - Pre-Submission Application Review
 * 
 * AI-powered compliance check that flags issues, missing info,
 * and provides actionable recommendations before submission.
 */
export default function ComplianceChecker({ grant, organization, applicationData }) {
  const [isChecking, setIsChecking] = useState(false);
  const [complianceReport, setComplianceReport] = useState(null);
  
  const { toast } = useToast();

  const handleRunCheck = async () => {
    setIsChecking(true);
    setComplianceReport(null);

    try {
      toast({
        title: '🔍 Running Compliance Check',
        description: 'AI is analyzing your application for issues...',
      });

      const response = await base44.functions.invoke('checkApplicationCompliance', {
        body: {
          grant_id: grant.id,
          organization_id: organization.id,
          application_data: applicationData
        }
      });

      if (response.data.success) {
        setComplianceReport(response.data);

        const issueCount = response.data.critical_issues?.length || 0;
        const warningCount = response.data.warnings?.length || 0;

        if (issueCount === 0 && warningCount === 0) {
          toast({
            title: '✅ Application Ready!',
            description: `Compliance score: ${response.data.compliance_score}%. No critical issues found.`,
          });
        } else {
          toast({
            title: issueCount > 0 ? '⚠️ Issues Found' : '💡 Suggestions Available',
            description: `${issueCount} critical issues, ${warningCount} warnings`,
            duration: 6000,
          });
        }
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Check Failed',
        description: error.message,
      });
    } finally {
      setIsChecking(false);
    }
  };

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 border-red-400 text-red-900';
      case 'high': return 'bg-orange-100 border-orange-400 text-orange-900';
      case 'medium': return 'bg-amber-100 border-amber-400 text-amber-900';
      case 'low': return 'bg-blue-100 border-blue-400 text-blue-900';
      default: return 'bg-slate-100 border-slate-400 text-slate-900';
    }
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical': return <XCircle className="w-5 h-5 text-red-600" />;
      case 'high': return <AlertTriangle className="w-5 h-5 text-orange-600" />;
      default: return <AlertTriangle className="w-5 h-5 text-amber-600" />;
    }
  };

  return (
    <Card className="border-2 border-purple-500 shadow-lg">
      <CardHeader className="bg-gradient-to-r from-purple-50 to-blue-50">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Shield className="w-6 h-6 text-purple-600" />
              Pre-Submission Compliance Check
            </CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              AI-powered review to catch issues before you submit
            </p>
          </div>
          <Button
            onClick={handleRunCheck}
            disabled={isChecking}
            className="bg-gradient-to-r from-purple-600 to-blue-600"
          >
            {isChecking ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <Shield className="w-4 h-4 mr-2" />
                Run Compliance Check
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-6 space-y-6">
        {!complianceReport && !isChecking && (
          <div className="text-center py-12">
            <Shield className="w-16 h-16 mx-auto text-purple-300 mb-4" />
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Ready for Compliance Review
            </h3>
            <p className="text-slate-600 max-w-md mx-auto">
              Click "Run Compliance Check" to have AI analyze your application for:
            </p>
            <ul className="text-sm text-slate-600 mt-3 space-y-1">
              <li>✓ Missing required information</li>
              <li>✓ Eligibility verification</li>
              <li>✓ Document completeness</li>
              <li>✓ Compliance red flags</li>
              <li>✓ Quality improvements</li>
            </ul>
          </div>
        )}

        {complianceReport && (
          <div className="space-y-6">
            {/* Overall Score */}
            <Card className={`border-2 ${
              complianceReport.overall_status === 'ready' ? 'border-green-500 bg-green-50' :
              complianceReport.overall_status === 'needs_work' ? 'border-amber-500 bg-amber-50' :
              'border-red-500 bg-red-50'
            }`}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-2xl font-bold text-slate-900">
                      Compliance Score: {complianceReport.compliance_score}%
                    </h3>
                    <p className="text-sm text-slate-700 mt-1">
                      {complianceReport.overall_status === 'ready' ? '✅ Ready for Submission' :
                       complianceReport.overall_status === 'needs_work' ? '⚠️ Improvements Recommended' :
                       '🚨 Critical Issues Must Be Resolved'}
                    </p>
                  </div>
                  {complianceReport.overall_status === 'ready' ? (
                    <CheckCircle2 className="w-12 h-12 text-green-600" />
                  ) : complianceReport.overall_status === 'needs_work' ? (
                    <AlertTriangle className="w-12 h-12 text-amber-600" />
                  ) : (
                    <XCircle className="w-12 h-12 text-red-600" />
                  )}
                </div>
                <Progress value={complianceReport.compliance_score} className="h-3" />
              </CardContent>
            </Card>

            {/* Critical Issues */}
            {complianceReport.critical_issues?.length > 0 && (
              <div>
                <h4 className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <XCircle className="w-5 h-5 text-red-600" />
                  Critical Issues ({complianceReport.critical_issues.length})
                </h4>
                <div className="space-y-3">
                  {complianceReport.critical_issues.map((issue, idx) => (
                    <Alert key={idx} className={`border-2 ${getSeverityColor(issue.severity)}`}>
                      <div className="flex items-start gap-3">
                        {getSeverityIcon(issue.severity)}
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <Badge className="bg-white text-slate-900">
                              {issue.category?.replace(/_/g, ' ')}
                            </Badge>
                            <Badge variant="destructive">
                              {issue.severity}
                            </Badge>
                          </div>
                          <p className="font-semibold text-slate-900 mb-1">
                            {issue.issue}
                          </p>
                          {issue.field && (
                            <p className="text-sm text-slate-700 mb-2">
                              Field: <code className="bg-white px-2 py-1 rounded">{issue.field}</code>
                            </p>
                          )}
                          <div className="p-3 bg-white rounded-lg border mt-2">
                            <p className="text-sm font-medium text-slate-900 mb-1">
                              💡 How to Fix:
                            </p>
                            <p className="text-sm text-slate-700">
                              {issue.recommendation}
                            </p>
                          </div>
                        </div>
                      </div>
                    </Alert>
                  ))}
                </div>
              </div>
            )}

            {/* Warnings */}
            {complianceReport.warnings?.length > 0 && (
              <div>
                <h4 className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                  Warnings & Suggestions ({complianceReport.warnings.length})
                </h4>
                <div className="space-y-2">
                  {complianceReport.warnings.map((warning, idx) => (
                    <div key={idx} className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-amber-900">
                            {warning.issue}
                          </p>
                          <p className="text-xs text-amber-800 mt-1">
                            💡 {warning.recommendation}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Missing Fields */}
            {complianceReport.missing_fields?.length > 0 && (
              <Alert className="bg-red-50 border-red-300">
                <FileWarning className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-900">
                  <strong>Missing Required Fields:</strong>
                  <ul className="list-disc list-inside mt-2 text-sm">
                    {complianceReport.missing_fields.map((field, idx) => (
                      <li key={idx}>{field}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Document Gaps */}
            {complianceReport.document_gaps?.length > 0 && (
              <Alert className="bg-amber-50 border-amber-300">
                <FileWarning className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-900">
                  <strong>Missing Documents:</strong>
                  <ul className="list-disc list-inside mt-2 text-sm">
                    {complianceReport.document_gaps.map((doc, idx) => (
                      <li key={idx}>{doc}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Strengths */}
            {complianceReport.strengths?.length > 0 && (
              <div>
                <h4 className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-green-600" />
                  Application Strengths
                </h4>
                <div className="space-y-2">
                  {complianceReport.strengths.map((strength, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm text-green-800 bg-green-50 p-2 rounded-lg border border-green-200">
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                      <span>{strength}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Next Steps */}
            {complianceReport.next_steps?.length > 0 && (
              <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-blue-600" />
                    Recommended Next Steps
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-2">
                    {complianceReport.next_steps.map((step, idx) => (
                      <li key={idx} className="flex items-start gap-3 text-sm">
                        <span className="font-bold text-blue-600 shrink-0">
                          {idx + 1}.
                        </span>
                        <span className="text-slate-700">{step}</span>
                      </li>
                    ))}
                  </ol>
                  {complianceReport.estimated_completion_time && (
                    <p className="text-sm text-slate-600 mt-4 pt-4 border-t">
                      ⏱️ Estimated time to complete: <strong>{complianceReport.estimated_completion_time}</strong>
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}