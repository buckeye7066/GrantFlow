import React, { useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CheckCircle, AlertTriangle, Loader2, Shield, FileWarning, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// Status constants
const STATUS = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
};

/** Safe number format */
const formatNumber = (val) => {
  if (val === null || val === undefined) return 'N/A';
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return 'N/A';
  try {
    return num.toLocaleString();
  } catch {
    return String(num);
  }
};

/** Safe external link open */
const safeOpenLink = (url) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('[ExtractionResultCard] Failed to open link:', err);
  }
};

/**
 * Card displaying extracted grant information with save option
 */
export default function ExtractionResultCard({ 
  status = STATUS.IDLE, 
  error, 
  extractedData, 
  onSave, 
  isSaving = false,
  documentType = 'grant'
}) {
  const isDebtLetter = documentType === 'debt' || extractedData?.collector_name;
  
  const handleSave = useCallback(() => {
    if (typeof onSave === 'function') {
      onSave();
    }
  }, [onSave]);

  if (status === STATUS.IDLE) return null;

  return (
    <Card className="mt-8 shadow-xl border-0" role="region" aria-live="polite" aria-busy={status === STATUS.UPLOADING || status === STATUS.PROCESSING}>
      <CardHeader>
        <CardTitle className="flex items-center">
          {status === STATUS.UPLOADING && (
            <>
              <Loader2 className="w-6 h-6 mr-2 animate-spin" aria-hidden="true" /> 
              Uploading file...
            </>
          )}
          {status === STATUS.PROCESSING && (
            <>
              <Loader2 className="w-6 h-6 mr-2 animate-spin" aria-hidden="true" /> 
              AI is reading the document...
            </>
          )}
          {status === STATUS.SUCCESS && (
            <>
              <CheckCircle className="w-6 h-6 mr-2 text-emerald-500" aria-hidden="true" /> 
              Extraction Complete!
            </>
          )}
          {status === STATUS.ERROR && (
            <>
              <AlertTriangle className="w-6 h-6 mr-2 text-red-500" aria-hidden="true" /> 
              Processing Failed
            </>
          )}
        </CardTitle>
      </CardHeader>

      {error && (
        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error || 'An unknown error occurred'}</AlertDescription>
          </Alert>
        </CardContent>
      )}

      {extractedData && status === STATUS.SUCCESS && !isDebtLetter && (
        <CardContent className="space-y-4">
          <h3 className="text-lg font-semibold text-slate-800 border-b pb-2">
            Extracted Information
          </h3>
          <dl className="space-y-3">
            <div>
              <dt className="inline font-semibold">Title:</dt>{' '}
              <dd className="inline">{extractedData.title || 'N/A'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Funder:</dt>{' '}
              <dd className="inline">{extractedData.funder || 'N/A'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Deadline:</dt>{' '}
              <dd className="inline">{extractedData.deadline || 'N/A'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Opportunity #:</dt>{' '}
              <dd className="inline">{extractedData.opportunity_number || 'N/A'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Award Range:</dt>{' '}
              <dd className="inline">
                ${formatNumber(extractedData.award_floor)} - ${formatNumber(extractedData.award_ceiling)}
              </dd>
            </div>
            
            {extractedData.funder_email && (
              <div>
                <dt className="inline font-semibold">Email:</dt>{' '}
                <dd className="inline">{extractedData.funder_email}</dd>
              </div>
            )}
            {extractedData.funder_phone && (
              <div>
                <dt className="inline font-semibold">Phone:</dt>{' '}
                <dd className="inline">{extractedData.funder_phone}</dd>
              </div>
            )}
            {extractedData.funder_fax && (
              <div>
                <dt className="inline font-semibold">Fax:</dt>{' '}
                <dd className="inline">{extractedData.funder_fax}</dd>
              </div>
            )}
            {extractedData.funder_address && (
              <div>
                <dt className="inline font-semibold">Address:</dt>{' '}
                <dd className="inline">{extractedData.funder_address}</dd>
              </div>
            )}
            
            {extractedData.program_description && (
              <div className="space-y-1">
                <dt className="font-semibold">Description:</dt>
                <dd className="text-sm text-slate-600 bg-slate-50 p-3 rounded-md">
                  {extractedData.program_description}
                </dd>
              </div>
            )}
            
            {extractedData.eligibility_summary && (
              <div className="space-y-1">
                <dt className="font-semibold">Eligibility:</dt>
                <dd className="text-sm text-slate-600 bg-slate-50 p-3 rounded-md">
                  {extractedData.eligibility_summary}
                </dd>
              </div>
            )}
          </dl>

          <div className="flex justify-end pt-4 border-t">
            <Button
              onClick={handleSave}
              disabled={isSaving || typeof onSave !== 'function'}
              className={`bg-emerald-600 hover:bg-emerald-700 ${isSaving ? 'opacity-75' : ''}`}
              aria-label="Save this grant to your pipeline"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" aria-hidden="true" />
                  Save to Pipeline
                </>
              )}
            </Button>
          </div>
        </CardContent>
      )}

      {/* Debt Letter Results */}
      {extractedData && status === STATUS.SUCCESS && isDebtLetter && (
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 border-b pb-2">
            <FileWarning className="w-5 h-5 text-orange-500" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-slate-800">
              Debt Collection Letter Analysis
            </h3>
          </div>

          {/* Alerts for violations */}
          {Array.isArray(extractedData.potential_violations) && extractedData.potential_violations.length > 0 && (
            <Alert className="border-red-200 bg-red-50">
              <Shield className="h-4 w-4 text-red-600" aria-hidden="true" />
              <AlertTitle className="text-red-900">Potential FDCPA Violations Detected</AlertTitle>
              <AlertDescription className="text-red-800">
                <ul className="list-disc pl-4 mt-2 space-y-1">
                  {extractedData.potential_violations.map((v, i) => (
                    <li key={`violation-${i}`}>{v}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Key Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <dl className="space-y-3">
              <div>
                <dt className="inline font-semibold">Collector:</dt>{' '}
                <dd className="inline">{extractedData.collector_name || 'N/A'}</dd>
              </div>
              {extractedData.creditor_name && (
                <div>
                  <dt className="inline font-semibold">Original Creditor:</dt>{' '}
                  <dd className="inline">{extractedData.creditor_name}</dd>
                </div>
              )}
              <div>
                <dt className="inline font-semibold">Debt Type:</dt>{' '}
                <dd className="inline"><Badge variant="outline">{extractedData.debt_type || 'Unknown'}</Badge></dd>
              </div>
              {extractedData.account_number && (
                <div>
                  <dt className="inline font-semibold">Account #:</dt>{' '}
                  <dd className="inline">{extractedData.account_number}</dd>
                </div>
              )}
            </dl>
            <dl className="space-y-3">
              {extractedData.original_amount != null && (
                <div>
                  <dt className="inline font-semibold">Original Amount:</dt>{' '}
                  <dd className="inline">${formatNumber(extractedData.original_amount)}</dd>
                </div>
              )}
              <div>
                <dt className="inline font-semibold">Claimed Amount:</dt>{' '}
                <dd className="inline text-lg font-semibold text-red-600">
                  ${formatNumber(extractedData.current_amount)}
                </dd>
              </div>
              {extractedData.response_deadline && (
                <div>
                  <dt className="inline font-semibold">Response Deadline:</dt>{' '}
                  <dd className="inline"><Badge className="bg-orange-100 text-orange-800">{extractedData.response_deadline}</Badge></dd>
                </div>
              )}
              {extractedData.validation_notice && (
                <Badge className="bg-blue-100 text-blue-800">Validation Notice - 30 Day Dispute Window</Badge>
              )}
            </dl>
          </div>

          {/* Collector Contact */}
          {(extractedData.collector_address || extractedData.collector_phone) && (
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="font-semibold text-sm text-slate-700 mb-2">Collector Contact Info:</p>
              {extractedData.collector_address && <p className="text-sm">{extractedData.collector_address}</p>}
              {extractedData.collector_phone && <p className="text-sm">Phone: {extractedData.collector_phone}</p>}
            </div>
          )}

          {/* Dispute Rights */}
          {extractedData.dispute_rights && (
            <div className="space-y-1">
              <p className="font-semibold">Your Dispute Rights:</p>
              <p className="text-sm text-slate-600 bg-blue-50 p-3 rounded-md border border-blue-200">
                {extractedData.dispute_rights}
              </p>
            </div>
          )}

          {/* Suggested Actions */}
          {Array.isArray(extractedData.suggested_actions) && extractedData.suggested_actions.length > 0 && (
            <div className="space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <Shield className="w-4 h-4 text-green-600" aria-hidden="true" />
                Recommended Actions:
              </p>
              <ul className="space-y-2" role="list">
                {extractedData.suggested_actions.map((action, i) => (
                  <li key={`action-${i}`} className="flex items-start gap-2 text-sm bg-green-50 p-2 rounded border border-green-200">
                    <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    {action}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Assistance Programs */}
          {Array.isArray(extractedData.assistance_programs) && extractedData.assistance_programs.length > 0 && (
            <div className="space-y-2">
              <p className="font-semibold">Potential Assistance Programs:</p>
              <div className="flex flex-wrap gap-2">
                {extractedData.assistance_programs.map((program, i) => (
                  <Badge key={`program-${i}`} className="bg-purple-100 text-purple-800">
                    {program}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Legal Threat Warning */}
          {extractedData.legal_threats && (
            <Alert className="border-yellow-200 bg-yellow-50">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <AlertTitle className="text-yellow-900">Legal Action Threatened</AlertTitle>
              <AlertDescription className="text-yellow-800">
                This letter mentions potential legal action. Consider consulting with a consumer law attorney or legal aid organization.
              </AlertDescription>
            </Alert>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => safeOpenLink('https://www.consumerfinance.gov/ask-cfpb/what-is-a-debt-validation-letter-en-1920/')}
              aria-label="Open CFPB Dispute Guide in new tab"
            >
              <ExternalLink className="w-4 h-4 mr-2" aria-hidden="true" />
              CFPB Dispute Guide
            </Button>
            <Button
              variant="outline"
              onClick={() => safeOpenLink('https://www.consumerfinance.gov/complaint/')}
              aria-label="File CFPB Complaint in new tab"
            >
              <Shield className="w-4 h-4 mr-2" aria-hidden="true" />
              File CFPB Complaint
            </Button>
            {typeof onSave === 'function' && (
              <Button
                onClick={handleSave}
                disabled={isSaving}
                className={`bg-purple-600 hover:bg-purple-700 ml-auto ${isSaving ? 'opacity-75' : ''}`}
                aria-label="Find assistance programs"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                    Finding Help...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" aria-hidden="true" />
                    Find Assistance Programs
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}