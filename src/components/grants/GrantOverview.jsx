import React, { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { format } from 'date-fns';
import { DollarSign, Calendar, Percent, Building2, Heart, GraduationCap, FileCheck, Info, AlertTriangle, CheckCircle, Sparkles, Edit, Target, TrendingUp } from 'lucide-react';
import client from '@/api/client';
import { useToast } from '@/components/ui/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { formatReasonText } from '@/utils/reasonText';
import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds';

const StatCard = ({ icon: Icon, label, value, color }) => (
    <div className="flex flex-col p-4 rounded-lg bg-slate-50 border border-slate-200">
        <div className="flex items-center gap-2 text-sm text-slate-500">
            <Icon className={`w-4 h-4 ${color}`} />
            <span>{label}</span>
        </div>
        <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
);

const getOpportunityIcon = (type) => {
    switch (type) {
        case 'scholarship': return GraduationCap;
        case 'financial_assistance': return Heart;
        default: return Building2;
    }
};

const getApplicationMethodLabel = (method) => {
    switch (method) {
        case 'auto_fafsa': return 'Automatic via FAFSA';
        case 'auto_profile': return 'Automatic Profile Match';
        case 'nomination': return 'Nomination Required';
        case 'invitation': return 'Invitation Only';
        case 'no_application': return 'No Application Needed';
        case 'standard': return 'Standard Application';
        default: return 'Application Required';
    }
};

const getApplicationMethodColor = (method) => {
    switch (method) {
        case 'auto_fafsa':
        case 'auto_profile':
        case 'no_application':
            return 'bg-green-100 text-green-800 border-green-200';
        case 'nomination':
        case 'invitation':
            return 'bg-amber-100 text-amber-800 border-amber-200';
        default:
            return 'bg-blue-100 text-blue-800 border-blue-200';
    }
};

// Label comes from the shared scoreToMatchLabel so this card and the GrantDetail
// header never disagree (the old local copy mislabeled 50–64 as "Good"/65–79 as
// "Strong"). Colors/icons stay local but track the same 80/65/50/35 tiers.
const getMatchScoreColor = (score) => {
    const label = scoreToMatchLabel(score);
    if (score >= 80) return { bg: 'from-emerald-500 to-emerald-600', text: 'text-white', label, icon: '🎯' };
    if (score >= 65) return { bg: 'from-green-500 to-green-600', text: 'text-white', label, icon: '✨' };
    if (score >= 50) return { bg: 'from-blue-500 to-blue-600', text: 'text-white', label, icon: '👍' };
    if (score >= 35) return { bg: 'from-amber-500 to-amber-600', text: 'text-white', label, icon: '⚠️' };
    return { bg: 'from-slate-400 to-slate-500', text: 'text-white', label, icon: '❓' };
};

const capitalize = (s) => (s && s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')) || "";

const formatAmount = (value) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const num = Number(value);
    if (!Number.isFinite(num)) return 'N/A';
    return `$${num.toLocaleString()}`;
};

export default function GrantOverview({ grant, organization, onUpdate, onOpenPrintApp }) {
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isVerifying, setIsVerifying] = useState(false);
    const [showContactNotes, setShowContactNotes] = useState(false);
    const [contactNotes, setContactNotes] = useState(grant?.contact_notes || '');
    const { profiles, activeProfileId } = useAuthStore();

    // Keep local contactNotes in sync when the grant changes (navigation/refetch).
    // useState only reads its initial argument on first mount, so without this the
    // Textarea would keep showing stale notes for a different/updated grant.
    useEffect(() => {
        setContactNotes(grant?.contact_notes || '');
        setShowContactNotes(false);
    }, [grant?.id, grant?.contact_notes]);

    const activeProfile = useMemo(() => {
        const id = activeProfileId ? String(activeProfileId) : null;
        if (!id) return null;
        return (profiles || []).find((p) => String(p?.id) === id) || null;
    }, [profiles, activeProfileId]);

    // The grant was scored against ITS OWN profile_id — attribute to that, not the
    // UI's activeProfileId, which (e.g. opening a grant from the general pipeline)
    // can fall back to a designated default profile and mislabel "scored against".
    const scoredAgainstProfile = useMemo(() => {
        const gid = grant?.profile_id ? String(grant.profile_id) : null;
        if (gid) {
            const match = (profiles || []).find((p) => String(p?.id) === gid);
            if (match) return match;
        }
        return activeProfile;
    }, [profiles, grant?.profile_id, activeProfile]);

    const updateGrantMutation = useMutation({
        mutationFn: (data) => client.entities.Grant.update(grant.id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
            if (onUpdate) onUpdate();
        }
    });

    if (!grant) return null;

    const OpportunityIcon = getOpportunityIcon(grant.opportunity_type);
    const deadlineDate = grant.deadline ? new Date(grant.deadline) : null;
    const isDeadlineValid = deadlineDate && !isNaN(deadlineDate.getTime());
    const showApplicationMethodAlert = grant.application_method && ['auto_fafsa', 'auto_profile', 'nomination', 'invitation', 'no_application'].includes(grant.application_method);
    
    const hasContactInfo = grant.contact_email || grant.contact_phone || grant.funder_fax || grant.funder_address;
    const matchScore = grant.match_score || 0;
    const hasMatchScore = matchScore > 0;
    const matchColor = getMatchScoreColor(matchScore);

    const handleReverifyContact = async () => {
        if (!grant.funder) {
            toast({
                variant: 'destructive',
                title: 'Cannot Verify',
                description: 'Funder name is required to verify contact information.'
            });
            return;
        }

        setIsVerifying(true);
        
        try {
            // NOTE: Only the publicly available funder name and public portal URL are
            // sent to the AI. No applicant/organization PII is included in the prompt.
            // The AI is asked to look up publicly listed contact details for the funder.
            const prompt = `Find and verify current PUBLICLY LISTED contact information for the following grant funder organization. Only return information that is publicly available on official sources.

Funder organization: "${grant.funder}"
${grant.url ? `Public website/portal: ${grant.url}` : ''}

Search the internet and provide verified, current PUBLIC contact information in JSON format:
{
  "email": "their public grants/contact email",
  "phone": "their public phone number", 
  "fax": "their public fax number if available",
  "address": "their public physical mailing address",
  "verification_notes": "brief note about sources and confidence level"
}

Return ONLY the JSON. Use null for any information you cannot verify with confidence from public sources.`;

            const response = await client.integrations.Core.InvokeLLM({
                prompt,
                add_context_from_internet: true,
                response_json_schema: {
                    type: "object",
                    properties: {
                        email: { type: ["string", "null"] },
                        phone: { type: ["string", "null"] },
                        fax: { type: ["string", "null"] },
                        address: { type: ["string", "null"] },
                        verification_notes: { type: "string" }
                    }
                }
            });

            if (!response || typeof response !== 'object' || Array.isArray(response)) {
                console.error('[GrantOverview] Malformed AI response (not an object):', response);
                throw new Error('AI returned an invalid response. Cannot update contact information.');
            }

            const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const PHONE_RE = /^[\d\s().+-]{7,20}$/;

            // Strict per-field validation. Each field must be a string of the expected
            // shape before it is accepted; anything else is ignored and logged.
            const isValidString = (v) => typeof v === 'string' && v.trim().length > 0;

            const verificationNotes = isValidString(response.verification_notes)
                ? response.verification_notes.trim()
                : 'Re-verified via AI';

            const updates = {
                // Do NOT auto-set contact_verified for AI results — explicit human
                // confirmation is required via handleMarkAsVerified.
                contact_notes: `AI re-verification (unconfirmed): ${verificationNotes}`
            };

            const rejected = [];

            if (response.email !== null && response.email !== undefined) {
                if (isValidString(response.email) && EMAIL_RE.test(response.email.trim())) {
                    updates.funder_email = response.email.trim();
                } else {
                    rejected.push('email');
                }
            }
            if (response.phone !== null && response.phone !== undefined) {
                if (isValidString(response.phone) && PHONE_RE.test(response.phone.trim())) {
                    updates.funder_phone = response.phone.trim();
                } else {
                    rejected.push('phone');
                }
            }
            if (response.fax !== null && response.fax !== undefined) {
                if (isValidString(response.fax) && PHONE_RE.test(response.fax.trim())) {
                    updates.funder_fax = response.fax.trim();
                } else {
                    rejected.push('fax');
                }
            }
            if (response.address !== null && response.address !== undefined) {
                if (isValidString(response.address) && response.address.trim().length > 5) {
                    updates.funder_address = response.address.trim();
                } else {
                    rejected.push('address');
                }
            }

            if (rejected.length > 0) {
                console.warn('[GrantOverview] AI returned malformed/invalid fields, ignored:', rejected, response);
            }

            await updateGrantMutation.mutateAsync(updates);

            toast({
                title: 'Contact Info Fetched',
                description: 'AI fetched updated contact information. Please review and manually confirm it before relying on it.'
            });

        } catch (error) {
            console.error('[GrantOverview] Verification failed:', error);
            toast({
                variant: 'destructive',
                title: 'Verification Failed',
                description: error.message || 'Could not verify contact information'
            });
        } finally {
            setIsVerifying(false);
        }
    };

    const handleMarkAsVerified = async () => {
        try {
            await updateGrantMutation.mutateAsync({
                contact_verified: true,
                contact_verified_date: new Date().toISOString(),
                contact_notes: contactNotes || 'Manually verified'
            });

            toast({
                title: 'Marked as Verified ✓',
                description: 'Contact information marked as verified.'
            });

            setShowContactNotes(false);
        } catch (error) {
            console.error('[GrantOverview] Mark as verified failed:', error);
            toast({
                variant: 'destructive',
                title: 'Could Not Save',
                description: error.message || 'Failed to mark contact information as verified. Please try again.'
            });
        }
    };

    const handleReportIssue = () => {
        setShowContactNotes(true);
    };

    return (
        <div className="space-y-6">
            {/* Match Score Highlight - NEW! */}
            {hasMatchScore && (
                <Card className={`shadow-lg border-0 bg-gradient-to-br ${matchColor.bg} ${matchColor.text} overflow-hidden relative`}>
                    <div className="absolute top-0 right-0 w-32 h-32 opacity-10">
                        <Target className="w-full h-full" />
                    </div>
                    <CardContent className="p-6 relative">
                        <div className="flex items-center justify-between">
                            <div className="flex-1">
                                <div className="flex items-center gap-3 mb-2">
                                    <Target className="w-8 h-8" />
                                    <div>
                                        <h3 className="text-2xl font-bold">AI Match Score</h3>
                                        <p className="text-sm opacity-90">{matchColor.label}</p>
                                    </div>
                                </div>
                                <p className="text-sm opacity-80 max-w-2xl">
                                    This opportunity was scored based on alignment with{' '}
                                    <span className="font-semibold">
                                        {scoredAgainstProfile?.display_name || organization?.name || 'your selected profile'}
                                    </span>
                                    ’s mission, eligibility, location, and key focus areas.
                                </p>
                                <p className="text-xs opacity-75 mt-2">
                                    Scored against profile:{' '}
                                    <span className="font-semibold">
                                        {scoredAgainstProfile?.display_name || 'your selected profile'}
                                    </span>
                                </p>
                                {(() => {
                                    // Coerce defensively — `match_explanation` may arrive
                                    // from the matcher as an object (e.g. `{reason, source}`)
                                    // depending on which producer wrote the row. Rendering
                                    // an object directly here is exactly the React error
                                    // #31 fingerprint that crashed the GrantDetail route.
                                    const explanationText = formatReasonText(grant.match_explanation)
                                    return explanationText ? (
                                        <p className="text-sm opacity-90 mt-3 italic">{explanationText}</p>
                                    ) : null
                                })()}
                                {Array.isArray(grant.matched_needs) && grant.matched_needs.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                        {grant.matched_needs.map((need, i) => {
                                            // `need` can be either a snake_case slug or an
                                            // object — coerce via formatReasonText, then
                                            // pretty-print snake_case after coercion.
                                            const text = formatReasonText(need).replace(/_/g, ' ')
                                            return text ? (
                                                <span key={i} className="bg-white/20 rounded-full px-2 py-0.5 text-xs font-medium">
                                                    {text}
                                                </span>
                                            ) : null
                                        })}
                                    </div>
                                )}
                            </div>
                            <div className="text-center">
                                <div className="text-6xl font-bold mb-1">{matchScore}%</div>
                                <div className="text-2xl">{matchColor.icon}</div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Verification Status Alert */}
            {hasContactInfo && !grant.contact_verified && (
                <Alert className="border-2 border-amber-200 bg-amber-50">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertTitle className="text-amber-900">Contact Information Not Verified</AlertTitle>
                    <AlertDescription className="text-amber-800">
                        <p className="mb-3">This contact information was auto-generated by AI and has not been manually verified. Please verify before submitting your application.</p>
                        <div className="flex gap-2">
                            <Button 
                                size="sm" 
                                variant="outline" 
                                onClick={handleReverifyContact}
                                disabled={isVerifying}
                                className="bg-white"
                            >
                                {isVerifying ? <><Sparkles className="w-3 h-3 mr-2 animate-spin" /> Verifying...</> : <><Sparkles className="w-3 h-3 mr-2" /> Re-verify with AI</>}
                            </Button>
                            <Button 
                                size="sm" 
                                variant="outline"
                                onClick={handleReportIssue}
                                className="bg-white"
                            >
                                <Edit className="w-3 h-3 mr-2" />
                                Report Issue
                            </Button>
                        </div>
                    </AlertDescription>
                </Alert>
            )}

            {/* Verified Badge */}
            {hasContactInfo && grant.contact_verified && (
                <Alert className="border-2 border-green-200 bg-green-50">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-800 flex items-center justify-between">
                        <div>
                            <strong>Contact Info Verified ✓</strong>
                            {grant.contact_verified_date && (
                                <span className="ml-2 text-sm">
                                    on {format(new Date(grant.contact_verified_date), 'MMM d, yyyy')}
                                </span>
                            )}
                            {grant.contact_notes && (
                                <p className="text-sm mt-1">{grant.contact_notes}</p>
                            )}
                        </div>
                        <Button 
                            size="sm" 
                            variant="ghost"
                            onClick={handleReportIssue}
                            className="text-green-700 hover:text-green-900"
                        >
                            Update
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            {/* Contact Notes Editor */}
            {showContactNotes && (
                <Card className="border-2 border-blue-200">
                    <CardHeader>
                        <CardTitle className="text-lg">Contact Verification Notes</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label>Notes (optional)</Label>
                            <Textarea 
                                value={contactNotes}
                                onChange={(e) => setContactNotes(e.target.value)}
                                placeholder="E.g., 'Called and verified phone number. Fax line is disconnected.' or 'Email confirmed via website contact page.'"
                                rows={3}
                            />
                        </div>
                        <div className="flex gap-3">
                            <Button onClick={handleMarkAsVerified}>
                                <CheckCircle className="w-4 h-4 mr-2" />
                                Mark as Verified
                            </Button>
                            <Button variant="outline" onClick={() => setShowContactNotes(false)}>
                                Cancel
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Application Method Alert */}
            {showApplicationMethodAlert && (
                <Alert className={`border-2 ${getApplicationMethodColor(grant.application_method)}`}>
                    <Info className="h-4 w-4" />
                    <AlertDescription className="ml-2">
                        <strong>{getApplicationMethodLabel(grant.application_method)}:</strong>
                        {grant.application_instructions ? (
                            <span className="ml-1">{grant.application_instructions}</span>
                        ) : (
                            <>
                                {grant.application_method === 'auto_fafsa' && ' Complete your FAFSA to be automatically considered for this scholarship.'}
                                {grant.application_method === 'auto_profile' && ' You will be automatically matched based on your profile information.'}
                                {grant.application_method === 'nomination' && ' This opportunity requires a nomination from an eligible nominator.'}
                                {grant.application_method === 'invitation' && ' This is an invitation-only opportunity.'}
                                {grant.application_method === 'no_application' && ' No separate application is required for this opportunity.'}
                            </>
                        )}
                    </AlertDescription>
                </Alert>
            )}

            <Card className="shadow-lg border-0">
                <CardHeader>
                    <CardTitle>Opportunity Snapshot</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard 
                        label="Max Award"
                        value={formatAmount(grant.amount_max)}
                        icon={DollarSign}
                        color="text-emerald-600"
                    />
                    <StatCard 
                        label="Deadline"
                        value={isDeadlineValid ? format(deadlineDate, 'MMM d, yyyy') : (grant.deadline || 'Ongoing')}
                        icon={Calendar}
                        color="text-amber-600"
                    />
                    {hasMatchScore && (
                        <StatCard 
                            label="Match Score"
                            value={`${matchScore}%`}
                            icon={Target}
                            color="text-purple-600"
                        />
                    )}
                    <StatCard 
                        label="Type"
                        value={capitalize(grant.opportunity_type) || 'Grant'}
                        icon={OpportunityIcon}
                        color="text-blue-600"
                    />
                </CardContent>
            </Card>

            {/* How to Apply / Submission Details Card */}
            <Card className="shadow-lg border-0">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <FileCheck className="w-5 h-5 text-blue-600" />
                        How to Apply
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {grant.application_method && (
                        <div className="flex items-start gap-3">
                            <Badge className={`${getApplicationMethodColor(grant.application_method)} px-3 py-1 text-sm`}>
                                {getApplicationMethodLabel(grant.application_method)}
                            </Badge>
                            {grant.application_instructions && (
                                <p className="text-slate-700 flex-1">{grant.application_instructions}</p>
                            )}
                        </div>
                    )}

                    {(grant.status !== 'rejected' && grant.status !== 'declined' && grant.status !== 'closed') && (grant.application_url || grant.url || grant.funder_address || grant.funder_fax) && (
                        <Alert className="border-2 border-blue-200 bg-blue-50">
                            <Info className="h-4 w-4 text-blue-600" />
                            <AlertTitle className="text-blue-900">Ready to Submit</AlertTitle>
                            <AlertDescription className="text-blue-800 space-y-2">
                                {(grant.application_url || grant.url) && (
                                    <div>
                                        <strong>Apply online:</strong>{' '}
                                        {(() => {
  const applyUrl = grant.application_url || grant.url;
  const isValidUrl = typeof applyUrl === 'string' && /^https?:\/\//i.test(applyUrl);
  return isValidUrl
    ? <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="underline font-semibold">{applyUrl}</a>
    : <span className="text-slate-500 italic">URL not available</span>;
})()}
                                    </div>
                                )}
                                {grant.funder_address && (
                                    <div><strong>Mail to:</strong> <span className="font-medium">{grant.funder_address}</span></div>
                                )}
                                {grant.funder_fax && (
                                    <div><strong>Fax to:</strong> <span className="font-medium">{grant.funder_fax}</span></div>
                                )}
                                {grant.contact_email && (
                                    <div><strong>Email to:</strong> <a href={`mailto:${grant.contact_email}`} className="underline font-semibold">{grant.contact_email}</a></div>
                                )}
                                {(grant.funder_address || grant.funder_fax) && onOpenPrintApp && (
                                    <Button size="sm" onClick={onOpenPrintApp} className="mt-2 gap-2 bg-blue-600 hover:bg-blue-700">
                                        <FileCheck className="w-4 h-4" /> Generate Printable Application
                                    </Button>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}

                    {grant.application_steps && (
                        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                            <h4 className="text-sm font-semibold text-indigo-900 mb-2">Step-by-Step Submission Guide</h4>
                            <div className="text-sm text-indigo-800 whitespace-pre-line">{grant.application_steps}</div>
                        </div>
                    )}

                    {(grant.application_url || grant.url) && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-600">Portal/Apply Link:</span>
                            {(() => {
                              const portalUrl = grant.application_url || grant.url;
                              const isValid = typeof portalUrl === 'string' && /^https?:\/\//i.test(portalUrl) && !['N/A', 'TBD', 'n/a', 'tbd'].includes(portalUrl.trim());
                              return isValid
                                ? <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm truncate max-w-md">{portalUrl}</a>
                                : <span className="text-slate-500 italic text-sm">No application link available</span>;
                            })()}
                        </div>
                    )}

                    {(grant.funder_address || grant.funder_fax || grant.contact_name || grant.contact_email || grant.contact_phone) && (
                        <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                            <h4 className="text-sm font-semibold text-slate-700">Contact & Submission Details</h4>
                            {(grant.contact_name || grant.contact_email || grant.contact_phone) && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                                    {grant.contact_name && <div><span className="text-slate-500">Contact:</span> <span className="font-medium">{grant.contact_name}</span></div>}
                                    {grant.contact_email && <div><span className="text-slate-500">Email:</span> <a href={`mailto:${grant.contact_email}`} className="text-blue-600 hover:underline">{grant.contact_email}</a></div>}
                                    {(grant.contact_phone) && <div><span className="text-slate-500">Phone:</span> <a href={`tel:${grant.contact_phone}`} className="text-blue-600 hover:underline">{grant.contact_phone}</a></div>}
                                </div>
                            )}
                            {grant.funder_fax && (
                                <div className="text-sm"><span className="text-slate-500">Fax:</span> <span className="font-medium">{grant.funder_fax}</span></div>
                            )}
                            {grant.funder_address && (
                                <div className="text-sm">
                                    <span className="text-slate-500">Mailing Address:</span>
                                    <div className="font-medium whitespace-pre-line mt-1 bg-white p-2 rounded border">{grant.funder_address}</div>
                                </div>
                            )}
                        </div>
                    )}

                    {!grant.application_method && !grant.application_url && !grant.url && !grant.contact_email && (
                        <p className="text-slate-500 text-sm italic">No application method information available yet. Ask Anya to help research how to apply.</p>
                    )}
                </CardContent>
            </Card>

            <Card className="shadow-lg border-0">
                <CardHeader>
                    <CardTitle>Program Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div>
                        <h3 className="font-semibold text-slate-800 mb-2">Program Description</h3>
                        <p className="text-slate-700 whitespace-pre-wrap">{grant.program_description || "No description provided."}</p>
                    </div>
                     <div>
                        <h3 className="font-semibold text-slate-800 mb-2">Eligibility Summary</h3>
                        <p className="text-slate-700 whitespace-pre-wrap">{grant.eligibility_summary || "No eligibility summary provided."}</p>
                    </div>
                    <div>
                        <h3 className="font-semibold text-slate-800 mb-2">Selection Criteria</h3>
                        <p className="text-slate-700 whitespace-pre-wrap">{grant.selection_criteria || "No selection criteria provided."}</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
