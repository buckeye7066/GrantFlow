import React, { useState, useRef, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Sparkles,
  FileSearch,
  ClipboardList,
  User,
  GraduationCap,
  MapPin,
  FileText,
  DollarSign,
  Phone,
  Mail,
  Calendar,
  ExternalLink,
  Clock,
  Link2
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

// JSON extraction and repair helpers
function extractJSON(text) {
  if (typeof text !== 'string') return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return text;
  return text.slice(start, end + 1);
}

function repairJSON(text) {
  const repaired = text
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/\t|\r|\n/g, ' ')
    .trim();

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function parseAndValidateLLMResponse(raw) {
  // Support envelopes from integrations: { output } or { data } or plain object/string
  let payload = raw?.output ?? raw?.data ?? raw;
  let parsed = null;

  if (typeof payload === 'object' && payload !== null) {
    parsed = payload;
  } else if (typeof payload === 'string') {
    const extracted = extractJSON(payload);
    try {
      parsed = JSON.parse(extracted);
    } catch {
      parsed = repairJSON(String(extracted));
    }
  }

  if (!parsed || typeof parsed !== 'object') parsed = {};

  // Defaults
  if (parsed.eligible === undefined || parsed.eligible === null) parsed.eligible = false;
  if (!Array.isArray(parsed.eligibility_issues)) parsed.eligibility_issues = [];
  if (!Array.isArray(parsed.required_application_fields)) parsed.required_application_fields = [];
  if (!Array.isArray(parsed.required_documents)) parsed.required_documents = [];
  if (!Array.isArray(parsed.special_requirements)) parsed.special_requirements = [];
  if (!parsed.confidence) parsed.confidence = 'low';
  if (!parsed.recommendation) parsed.recommendation = 'Unable to fully analyze. Please review manually.';

  // Normalize arrays: helpful_links, key_dates
  if (!Array.isArray(parsed.key_dates)) parsed.key_dates = [];
  if (!Array.isArray(parsed.helpful_links)) parsed.helpful_links = [];

  // Normalize nested objects
  parsed.contact_info = parsed.contact_info && typeof parsed.contact_info === 'object' ? parsed.contact_info : {};
  parsed.application_details =
    parsed.application_details && typeof parsed.application_details === 'object' ? parsed.application_details : {};

  return parsed;
}

const ELIGIBILITY_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    eligible: { type: 'boolean' },
    confidence: { type: 'string' },
    eligibility_issues: {
      type: 'array',
      items: { type: 'object' }
    },
    required_application_fields: {
      type: 'array',
      items: { type: 'object' }
    },
    required_documents: {
      type: 'array',
      items: { type: 'object' }
    },
    application_portal: { type: 'string' },
    deadline: { type: 'string' },
    award_amount: { type: 'string' },
    special_requirements: {
      type: 'array',
      items: { type: 'string' }
    },
    recommendation: { type: 'string' },
    contact_info: {
      type: 'object',
      properties: {
        contact_name: { type: 'string' },
        contact_title: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        office_hours: { type: 'string' }
      }
    },
    application_details: {
      type: 'object',
      properties: {
        application_url: { type: 'string' },
        form_download_url: { type: 'string' },
        submission_method: { type: 'string' },
        submission_email: { type: 'string' },
        submission_address: { type: 'string' },
        application_opens: { type: 'string' },
        application_deadline: { type: 'string' },
        notification_date: { type: 'string' },
        award_date: { type: 'string' }
      }
    },
    key_dates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          description: { type: 'string' }
        }
      }
    },
    helpful_links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }
};

/**
 * EligibilityChecker - AI-powered eligibility analysis for grants
 */
export default function EligibilityChecker({ grant, organization }) {
  const { toast } = useToast();
  const [isChecking, setIsChecking] = useState(false);
  const [result, setResult] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sanitize URLs safely
  const sanitizeUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
      const trimmed = url.trim();
      const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const parsed = new URL(href);
      // Only allow http/https
      if (!/^https?:$/i.test(parsed.protocol)) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };

  // Normalize value to array
  const normalizeToArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return [v];
  };

  // Build comprehensive profile summary
  const buildProfileSummary = (org) => {
    if (!org || typeof org !== 'object') return 'No profile data available.';

    const lines = [];

    // Basic info
    lines.push(`Name: ${org.name || 'Not provided'}`);
    lines.push(`Type: ${org.applicant_type || 'Not specified'}`);

    // Location - CRITICAL: Always include for residency checks
    const city = org.city || '';
    const state = org.state || '';
    const zip = org.zip || '';
    const street = org.address || '';
    const locationParts = [city, state, zip].filter(Boolean);
    if (locationParts.length > 0) {
      lines.push(`Location: ${locationParts.join(', ')}`);
      lines.push(`City: ${city || 'Not provided'}`);
      lines.push(`State: ${state || 'Not provided'}`);
    }
    if (street) lines.push(`Street Address: ${street}`);

    // Contact (tolerate array or string)
    const emails = normalizeToArray(org.email).filter(Boolean);
    const phones = normalizeToArray(org.phone).filter(Boolean);
    if (emails.length) lines.push(`Email: ${emails[0]}`);
    if (phones.length) lines.push(`Phone: ${phones[0]}`);

    // Education (for students)
    if (org.gpa) lines.push(`GPA: ${org.gpa}`);
    if (org.current_college) lines.push(`Current College: ${org.current_college}`);
    if (org.intended_major) lines.push(`Intended Major: ${org.intended_major}`);
    const targets = normalizeToArray(org.target_colleges).filter(Boolean);
    if (targets.length) lines.push(`Target Colleges: ${targets.join(', ')}`);
    const gradeLevels = normalizeToArray(org.student_grade_levels || org.grade_levels).filter(Boolean);
    if (gradeLevels.length) lines.push(`Grade Level: ${gradeLevels.join(', ')}`);

    // Test scores
    if (org.test_scores && typeof org.test_scores === 'object') {
      const scores = [];
      if (org.test_scores.act) scores.push(`ACT: ${org.test_scores.act}`);
      if (org.test_scores.sat) scores.push(`SAT: ${org.test_scores.sat}`);
      if (scores.length) lines.push(`Test Scores: ${scores.join(', ')}`);
    }

    // Education history
    if (Array.isArray(org.education_history) && org.education_history.length) {
      org.education_history.forEach((edu) => {
        if (edu && typeof edu === 'object') {
          const inst = [edu.institution_name, edu.institution_type].filter(Boolean).join(' ');
          if (inst) lines.push(`Education: ${inst}`);
        }
      });
    }

    // Focus areas and goals
    const focusAreas = normalizeToArray(org.focus_areas).filter(Boolean);
    if (focusAreas.length) lines.push(`Focus Areas: ${focusAreas.join(', ')}`);
    if (org.primary_goal) lines.push(`Primary Goal: ${org.primary_goal}`);
    if (org.goals) lines.push(`Goals: ${org.goals}`);

    // Mission/story
    if (org.mission) lines.push(`Mission: ${org.mission}`);
    if (org.unique_story) lines.push(`Unique Story: ${org.unique_story}`);

    // Financial
    if (org.household_income) lines.push(`Household Income: $${org.household_income}`);
    const finCh = normalizeToArray(org.financial_challenges).filter(Boolean);
    if (finCh.length) lines.push(`Financial Challenges: ${finCh.join(', ')}`);
    const govAid = normalizeToArray(org.government_assistance).filter(Boolean);
    if (govAid.length) lines.push(`Government Assistance: ${govAid.join(', ')}`);

    // Activities
    const activities = normalizeToArray(org.extracurricular_activities).filter(Boolean);
    if (activities.length) lines.push(`Activities: ${activities.join(', ')}`);
    const awards = normalizeToArray(org.awards_achievements).filter(Boolean);
    if (awards.length) lines.push(`Awards: ${awards.join(', ')}`);
    if (org.community_service_hours) lines.push(`Community Service Hours: ${org.community_service_hours}`);

    // Demographics
    const raceEth = normalizeToArray(org.race_ethnicity).filter(Boolean);
    if (raceEth.length) lines.push(`Race/Ethnicity: ${raceEth.join(', ')}`);

    // Special circumstances
    const qualifiers = normalizeToArray(org.student_qualifiers).filter(Boolean);
    if (qualifiers.length) lines.push(`Student Qualifiers: ${qualifiers.join(', ')}`);
    if (org.special_circumstances) lines.push(`Special Circumstances: ${org.special_circumstances}`);

    return lines.join('\n');
  };

  const handleCheckEligibility = async () => {
    if (isChecking) return; // guard double-click
    if (!grant || !organization) {
      toast({
        variant: 'destructive',
        title: 'Missing Data',
        description: 'Grant and organization information required'
      });
      return;
    }

    setIsChecking(true);
    setResult(null);

    try {
      const profileSummary = buildProfileSummary(organization);

      const prompt = `You are an expert grant/scholarship eligibility analyst. Analyze whether this applicant is eligible for this funding opportunity.

FUNDING OPPORTUNITY:
Name: ${grant.title || 'Unknown'}
Funder: ${grant.funder || 'Unknown'}
${grant.program_description ? `Description: ${grant.program_description}` : ''}
${grant.url ? `URL: ${grant.url}` : ''}

APPLICANT PROFILE:
${profileSummary}

TASKS:
1. ELIGIBILITY CHECK: Determine if applicant meets ALL eligibility criteria including geographic/residency requirements.
2. REQUIRED FIELDS: List EVERY field required for the application and whether it exists in profile.
3. REQUIRED DOCUMENTS: List ALL documents typically required for this type of opportunity.
4. SPECIAL REQUIREMENTS: Note FAFSA, essays, geographic restrictions, GPA minimums, test scores, recommendation letters, etc.
5. ISSUES: Flag BLOCKING (clearly ineligible), WARNING (missing info), or INFO (suggestions).

CRITICAL RULES - RESIDENCY/GEOGRAPHY:
- The applicant's FULL address is shown above (Street Address, City, State, ZIP)
- ONLY flag geographic/residency issues if the applicant's location clearly does NOT match the funder's requirements
- Example: If applicant is in "Cleveland, TN" and funder serves "Cleveland, TN" → NO residency issue
- Example: If applicant is in "Nashville, TN" and funder only serves "Cleveland, TN residents" → Flag as BLOCKING
- When in doubt about residency - do NOT flag it as an issue

CRITICAL RULES - REQUIRED FIELDS:
- List EVERY field that the application form will ask for (Name, Email, Phone, Address, City, State, ZIP are ALWAYS required)
- For scholarships/student funding: Also list GPA, Test Scores, School, Grade Level, Intended Major, etc.
- For organization grants: Also list EIN, Budget, Mission, Programs, etc.
- Mark each field as present_in_profile: true/false based on the applicant profile above
- If a field exists in the profile, show its value in profile_value
- Be THOROUGH - list 10-20+ required fields depending on the opportunity type

CRITICAL RULES - CONTACT & APPLICATION INFO:
- SEARCH the funder's website for contact information (name, email, phone, address)
- FIND the application portal URL, form download links, and submission instructions
- IDENTIFY key dates: application opens, deadline, notification date, award date
- INCLUDE helpful links: funder website, FAQ, guidelines, sample applications
- For local organizations (lodges, churches, clubs), find their meeting times/contact person

CRITICAL RULES - JSON OUTPUT:
- Return ONLY valid JSON. No commentary outside the JSON object.
- Ensure all strings are properly escaped.`;

      const llm = base44?.integrations?.Core?.InvokeLLM;
      if (typeof llm !== 'function') {
        throw new Error('AI service unavailable');
      }

      const rawResponse = await llm({
        prompt,
        add_context_from_internet: true,
        response_json_schema: ELIGIBILITY_CHECK_SCHEMA
      });

      const response = parseAndValidateLLMResponse(rawResponse);
      if (!mountedRef.current) return;
      setResult(response);

      // Save eligibility check result to grant
      if (grant?.id) {
        try {
          await base44.entities.Grant.update(grant.id, {
            eligibility_checked: true,
            eligibility_check_date: new Date().toISOString(),
            eligible: response.eligible,
            eligibility_confidence: response.confidence,
            eligibility_notes: response.recommendation || 'Eligibility check completed'
          });
        } catch (saveErr) {
          console.warn('[EligibilityChecker] Failed to save result:', saveErr);
        }
      }

      if (response.eligible) {
        toast({
          title: '✅ Eligibility Check Complete',
          description: 'Applicant appears eligible. Progress saved.'
        });
      } else {
        toast({
          variant: 'destructive',
          title: '⚠️ Eligibility Issues Found',
          description: 'There may be problems with this application. Review saved.'
        });
      }
    } catch (error) {
      console.error('[EligibilityChecker] Error:', error);
      if (!mountedRef.current) return;
      toast({
        variant: 'destructive',
        title: 'Check Failed',
        description: error?.message || 'Could not complete eligibility check'
      });
    } finally {
      if (mountedRef.current) setIsChecking(false);
    }
  };

  const getSeverityIcon = (severity) => {
    switch ((severity || '').toLowerCase()) {
      case 'blocking':
        return <XCircle className="w-4 h-4 text-red-600" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-600" />;
      case 'info':
        return <CheckCircle2 className="w-4 h-4 text-blue-600" />;
      default:
        return null;
    }
  };

  const getSeverityBadge = (severity) => {
    const s = (severity || '').toLowerCase();
    const styles = {
      blocking: 'bg-red-100 text-red-800 border-red-200',
      warning: 'bg-amber-100 text-amber-800 border-amber-200',
      info: 'bg-blue-100 text-blue-800 border-blue-200'
    };
    return styles[s] || styles.info;
  };

  // Safe link helper
  const safeHref = (url) => sanitizeUrl(url) || undefined;

  return (
    <div className="space-y-4">
      {!result && (
        <div className="text-center py-6">
          <FileSearch className="w-12 h-12 text-blue-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Eligibility & Requirements Check</h3>
          <p className="text-slate-600 text-sm mb-4">
            AI will analyze the funder's requirements and check if the applicant profile has all required information.
          </p>
          <Button
            onClick={handleCheckEligibility}
            disabled={isChecking}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isChecking ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing Requirements...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Check Eligibility & Requirements
              </>
            )}
          </Button>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* Overall Status */}
          <Alert className={result.eligible ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}>
            <div className="flex items-start gap-3">
              {result.eligible ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 mt-0.5" />
              )}
              <div className="flex-1">
                <p className={`font-semibold ${result.eligible ? 'text-green-900' : 'text-red-900'}`}>
                  {result.eligible ? 'Applicant Appears Eligible' : 'Eligibility Issues Found'}
                </p>
                <p className={`text-sm ${result.eligible ? 'text-green-800' : 'text-red-800'}`}>
                  Confidence: {result.confidence}
                </p>
              </div>
              <Badge variant="outline">{result.confidence} confidence</Badge>
            </div>
          </Alert>

          {/* Award Info */}
          {(result.award_amount || result.deadline || safeHref(result.application_portal)) && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <DollarSign className="w-4 h-4" />
                  Opportunity Details
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-1 text-sm">
                {result.award_amount && <p><strong>Award:</strong> {result.award_amount}</p>}
                {result.deadline && <p><strong>Deadline:</strong> {result.deadline}</p>}
                {safeHref(result.application_portal) && (
                  <p>
                    <strong>Apply at:</strong>{' '}
                    <a
                      href={safeHref(result.application_portal)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {result.application_portal}
                    </a>
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Eligibility Issues */}
          {result.eligibility_issues?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  Eligibility Issues ({result.eligibility_issues.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-2">
                {result.eligibility_issues.map((issue, idx) => (
                  <div
                    key={`issue-${idx}`}
                    className={`p-2 rounded border ${getSeverityBadge(issue?.severity)}`}
                  >
                    <div className="flex items-start gap-2">
                      {getSeverityIcon(issue?.severity)}
                      <div className="flex-1">
                        <p className="text-sm font-medium">{issue?.issue || 'Unknown issue'}</p>
                        {issue?.details && (
                          <p className="text-xs opacity-75 mt-0.5">{issue.details}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {issue?.severity || 'info'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Required Fields */}
          {result.required_application_fields?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ClipboardList className="w-4 h-4" />
                  Required Application Fields ({result.required_application_fields.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {result.required_application_fields.map((field, idx) => (
                    <div
                      key={`field-${idx}`}
                      className={`p-2 rounded border text-sm ${
                        field?.present_in_profile
                          ? 'bg-green-50 border-green-200'
                          : 'bg-amber-50 border-amber-200'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {field?.present_in_profile ? (
                          <CheckCircle2 className="w-3 h-3 text-green-600" />
                        ) : (
                          <AlertTriangle className="w-3 h-3 text-amber-600" />
                        )}
                        <span className="font-medium">{field?.field_name || 'Unknown'}</span>
                      </div>
                      {field?.profile_value && (
                        <p className="text-xs text-slate-600 mt-1 truncate">
                          Value: {field.profile_value}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Required Documents */}
          {result.required_documents?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Required Documents ({result.required_documents.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-1">
                {result.required_documents.map((doc, idx) => (
                  <div key={`doc-${idx}`} className="flex items-center gap-2 text-sm">
                    <FileText className="w-3 h-3 text-slate-400" />
                    <span>{doc?.document_name || doc?.name || 'Unknown document'}</span>
                    {doc?.required && <Badge variant="outline" className="text-xs">Required</Badge>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Special Requirements */}
          {result.special_requirements?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <GraduationCap className="w-4 h-4" />
                  Special Requirements
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                <ul className="space-y-1 text-sm">
                  {result.special_requirements.map((req, idx) => (
                    <li key={`req-${idx}`} className="flex items-start gap-2">
                      <span className="text-blue-600">•</span>
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Contact Info */}
          {result.contact_info && Object.keys(result.contact_info).some(k => result.contact_info[k]) && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <User className="w-4 h-4" />
                  Contact Information
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-1 text-sm">
                {result.contact_info.contact_name && (
                  <p><strong>Contact:</strong> {result.contact_info.contact_name}</p>
                )}
                {result.contact_info.contact_title && (
                  <p><strong>Title:</strong> {result.contact_info.contact_title}</p>
                )}
                {result.contact_info.email && (
                  <p className="flex items-center gap-1">
                    <Mail className="w-3 h-3" />
                    <a href={`mailto:${result.contact_info.email}`} className="text-blue-600 hover:underline">
                      {result.contact_info.email}
                    </a>
                  </p>
                )}
                {result.contact_info.phone && (
                  <p className="flex items-center gap-1">
                    <Phone className="w-3 h-3" />
                    {result.contact_info.phone}
                  </p>
                )}
                {result.contact_info.address && (
                  <p className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {result.contact_info.address}
                  </p>
                )}
                {result.contact_info.office_hours && (
                  <p className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {result.contact_info.office_hours}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Key Dates */}
          {result.key_dates?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  Key Dates
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-1">
                {result.key_dates.map((kd, idx) => (
                  <div key={`date-${idx}`} className="flex items-center gap-2 text-sm">
                    <Calendar className="w-3 h-3 text-slate-400" />
                    <span className="font-medium">{kd?.date || 'TBD'}:</span>
                    <span>{kd?.description || ''}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Helpful Links */}
          {result.helpful_links?.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Link2 className="w-4 h-4" />
                  Helpful Links
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2 space-y-2">
                {result.helpful_links.map((link, idx) => {
                  const href = safeHref(link?.url);
                  if (!href) return null;
                  return (
                    <div key={`link-${idx}`} className="text-sm">
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {link?.title || href}
                      </a>
                      {link?.description && (
                        <p className="text-xs text-slate-500 ml-4">{link.description}</p>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Recommendation */}
          {result.recommendation && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  Recommendation
                </CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                <p className="text-sm text-slate-700">{result.recommendation}</p>
              </CardContent>
            </Card>
          )}

          {/* Re-check button */}
          <div className="text-center pt-2">
            <Button
              variant="outline"
              onClick={handleCheckEligibility}
              disabled={isChecking}
            >
              {isChecking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Re-check Eligibility
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}