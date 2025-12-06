import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { format } from 'date-fns';
import { DollarSign, Calendar, Target, Heart, GraduationCap, Building2, Info, X, FileSearch } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseDateSafe } from '@/components/shared/dateUtils';

// Import new subcomponents
import OpportunityStatCard from './overview/OpportunityStatCard';
import ContactVerificationCard from './overview/ContactVerificationCard';
import NextStepsCard from './overview/NextStepsCard';
import ApplicationRequirementsManager from '@/components/applications/ApplicationRequirementsManager';
import { Button } from '@/components/ui/button';
import Checklist from '@/components/workflow/Checklist';
import SubmissionAssistant from '@/components/proposals/SubmissionAssistant';
import EligibilityChecker from './EligibilityChecker';

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

const getMatchScoreColor = (score) => {
    if (score >= 80) return { bg: 'from-emerald-500 to-emerald-600', text: 'text-white', label: 'Excellent Match', icon: '🎯' };
    if (score >= 65) return { bg: 'from-green-500 to-green-600', text: 'text-white', label: 'Strong Match', icon: '✨' };
    if (score >= 50) return { bg: 'from-blue-500 to-blue-600', text: 'text-white', label: 'Good Match', icon: '👍' };
    if (score >= 35) return { bg: 'from-amber-500 to-amber-600', text: 'text-white', label: 'Fair Match', icon: '⚠️' };
    return { bg: 'from-slate-400 to-slate-500', text: 'text-white', label: 'Low Match', icon: '❓' };
};

const capitalize = (s) => (s && s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')) || "";

export default function GrantOverview({ grant, organization, onUpdate, onSubmit }) {
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isVerifying, setIsVerifying] = useState(false);
    const [showNOFOParser, setShowNOFOParser] = useState(false);
    const [showApplicationAssistant, setShowApplicationAssistant] = useState(false);
    const [showSubmissionAssistant, setShowSubmissionAssistant] = useState(false);
    const [showChecklist, setShowChecklist] = useState(false);
    const [showEligibilityChecker, setShowEligibilityChecker] = useState(false);

    const updateGrantMutation = useMutation({
        mutationFn: (data) => base44.entities.Grant.update(grant.id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['grant', grant.id] });
            if (onUpdate) onUpdate();
        }
    });

    if (!grant) return null;

    const OpportunityIcon = getOpportunityIcon(grant.opportunity_type);
    const deadlineDate = parseDateSafe(grant.deadline);
    const isDeadlineValid = deadlineDate !== null;
    const showApplicationMethodAlert = grant.application_method && ['auto_fafsa', 'auto_profile', 'nomination', 'invitation', 'no_application'].includes(grant.application_method);
    
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
            const prompt = `Find and verify current contact information for: "${grant.funder}"

${grant.url ? `Their website/portal: ${grant.url}` : ''}

Search the internet and provide verified, current contact information in JSON format:
{
  "email": "their grants/contact email",
  "phone": "their phone number", 
  "fax": "their fax number if available",
  "address": "their physical mailing address",
  "verification_notes": "brief note about sources and confidence level",
  "confidence": "high/medium/low - your confidence in the accuracy of this information"
}

Return ONLY the JSON. Use null for any information you cannot verify with confidence.`;

            const response = await base44.integrations.Core.InvokeLLM({
                prompt,
                add_context_from_internet: true,
                response_json_schema: {
                    type: "object",
                    properties: {
                        email: { type: ["string", "null"] },
                        phone: { type: ["string", "null"] },
                        fax: { type: ["string", "null"] },
                        address: { type: ["string", "null"] },
                        verification_notes: { type: "string" },
                        confidence: { type: "string" }
                    }
                }
            });

            const updates = {
                contact_verified: false, // Mark as unverified until user confirms
                contact_verified_date: null,
                contact_notes: `AI Re-verification (${response.confidence || 'unknown'} confidence): ${response.verification_notes || 'Contact info updated'}`
            };
            
            if (response.email) updates.funder_email = response.email;
            if (response.phone) updates.funder_phone = response.phone;
            if (response.fax) updates.funder_fax = response.fax;
            if (response.address) updates.funder_address = response.address;

            await updateGrantMutation.mutateAsync(updates);

            toast({
                title: 'Contact Info Updated ✓',
                description: `Re-verification complete (${response.confidence || 'unknown'} confidence). Please review and confirm.`
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

    const handleManualVerify = async (notes) => {
        await updateGrantMutation.mutateAsync({
            contact_verified: true,
            contact_verified_date: new Date().toISOString(),
            contact_notes: notes || 'Manually verified'
        });
        
        toast({
            title: 'Marked as Verified ✓',
            description: 'Contact information marked as verified.'
        });
    };

    const handleWorkflowAction = async (action) => {
        try {
            // Handle different action types
            switch (action) {
                case 'parse_nofo':
                    setShowNOFOParser(true);
                    break;
                    
                case 'build_checklist':
                case 'checklist':
                    setShowChecklist(true);
                    break;
                    
                case 'requirements':
                    // Navigate to requirements tab or show requirements section
                    setShowApplicationAssistant(true);
                    break;
                    
                case 'start_draft':
                case 'review_draft':
                case 'coach':
                case 'urgent_action':
                    // Navigate to coach tab
                    window.location.search = `?id=${grant.id}&tab=coach`;
                    break;
                    
                case 'submit':
                    setShowSubmissionAssistant(true);
                    break;
                    
                case 'verify_contact':
                    // Scroll to contact verification section
                    document.querySelector('[data-contact-verification]')?.scrollIntoView({ behavior: 'smooth' });
                    break;
                    
                case 'mark_interested':
                    await updateGrantMutation.mutateAsync({ status: 'interested' });
                    toast({ title: 'Status Updated', description: 'Grant marked as Interested' });
                    break;
                    
                case 'eligibility':
                    setShowEligibilityChecker(true);
                    break;
                    
                case 'reminders':
                    toast({ title: 'Coming Soon', description: 'Reminder functionality is in development' });
                    break;
                    
                default:
                    console.warn('[GrantOverview] Unhandled workflow action:', action);
                    // Fallback: show application assistant for unknown actions
                    setShowApplicationAssistant(true);
                    break;
            }
        } catch (error) {
            console.error('[GrantOverview] Error handling workflow action:', error);
            toast({
                variant: 'destructive',
                title: 'Action Failed',
                description: error?.message || 'Failed to execute workflow action'
            });
        }
    };

    return (
        <div className="space-y-6">
            {/* Match Score Highlight */}
            {hasMatchScore && (
                <Card className={`shadow-lg border-0 bg-gradient-to-br ${matchColor.bg} ${matchColor.text} overflow-hidden relative`}>
                    <div className="absolute top-0 right-0 w-32 h-32 opacity-10">
                        <Target className="w-full h-full" />
                    </div>
                    <CardContent className="p-6 relative">
                        <div className="flex items-center justify-between flex-wrap gap-4">
                            <div className="flex-1 min-w-[200px]">
                                <div className="flex items-center gap-3 mb-2">
                                    <Target className="w-8 h-8" />
                                    <div>
                                        <h3 className="text-2xl font-bold">AI Match Score</h3>
                                        <p className="text-sm opacity-90">{matchColor.label}</p>
                                    </div>
                                </div>
                                <p className="text-sm opacity-80 max-w-2xl">
                                    This opportunity was scored based on alignment with {organization?.name || 'your profile'}'s 
                                    mission, eligibility, location, and key focus areas.
                                </p>
                            </div>
                            <div className="text-center">
                                <div className="text-6xl font-bold mb-1">{matchScore}%</div>
                                <div className="text-2xl">{matchColor.icon}</div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Eligibility & Requirements Checker */}
            <Card className={`shadow-lg border-2 ${
              grant.eligibility_checked 
                ? grant.eligible 
                  ? 'border-green-300 bg-gradient-to-br from-green-50 to-emerald-50' 
                  : 'border-red-300 bg-gradient-to-br from-red-50 to-orange-50'
                : 'border-blue-300 bg-gradient-to-br from-blue-50 to-indigo-50'
            }`}>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <FileSearch className="w-5 h-5 text-blue-600" />
                            Eligibility & Requirements Check
                        </CardTitle>
                        {grant.eligibility_checked && (
                            <Badge 
                                className={`cursor-pointer transition-transform hover:scale-105 ${grant.eligible ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
                                onClick={() => setShowEligibilityChecker(true)}
                            >
                                {grant.eligible ? '✓ Eligible' : '✗ Issues Found'}
                            </Badge>
                        )}
                    </div>
                    {grant.eligibility_check_date && (
                        <p className="text-xs text-slate-500 mt-1">
                            Last checked: {format(new Date(grant.eligibility_check_date), 'MMM dd, yyyy h:mm a')}
                        </p>
                    )}
                </CardHeader>
                <CardContent>
                    {!showEligibilityChecker ? (
                        <div className="text-center py-4">
                            <p className="text-slate-600 text-sm mb-4">
                                {grant.eligibility_checked 
                                  ? 'Eligibility check completed. Click to review or check again.' 
                                  : 'Before applying, verify that the applicant meets all eligibility criteria and has all required information.'}
                            </p>
                            <Button
                                onClick={() => setShowEligibilityChecker(true)}
                                className={grant.eligibility_checked 
                                  ? 'bg-slate-600 hover:bg-slate-700' 
                                  : 'bg-blue-600 hover:bg-blue-700'}
                            >
                                <FileSearch className="w-4 h-4 mr-2" />
                                {grant.eligibility_checked ? 'Review Eligibility' : 'Check Eligibility & Requirements'}
                            </Button>
                        </div>
                    ) : (
                        <EligibilityChecker 
                            grant={grant} 
                            organization={organization}
                            onClose={() => setShowEligibilityChecker(false)}
                        />
                    )}
                </CardContent>
            </Card>

            {/* Application Requirements for this specific grant */}
            <ApplicationRequirementsManager 
                grantId={grant.id}
                organizationId={organization?.id}
                grantTitle={grant.title}
            />

            {/* Next Steps Card */}
            <NextStepsCard 
                grant={grant} 
                onAction={handleWorkflowAction}
            />

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

            {/* Contact Verification Card */}
            <ContactVerificationCard
                grant={grant}
                onReverify={handleReverifyContact}
                onManualVerify={handleManualVerify}
                isVerifying={isVerifying}
                onSubmit={onSubmit}
            />

            {/* Opportunity Stats */}
            <Card className="shadow-lg border-0">
                <CardHeader>
                    <CardTitle>Opportunity Snapshot</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <OpportunityStatCard 
                        label="Max Award"
                        value={grant.award_ceiling ? `$${grant.award_ceiling.toLocaleString()}` : 'N/A'}
                        icon={DollarSign}
                        color="text-emerald-600"
                        bgColor="bg-emerald-50"
                    />
                    <OpportunityStatCard 
                        label="Deadline"
                        value={(() => {
                            if (!isDeadlineValid) return grant.deadline || 'Ongoing';
                            try {
                                return format(deadlineDate, 'MMM d, yyyy');
                            } catch {
                                return 'Invalid date';
                            }
                        })()}
                        icon={Calendar}
                        color="text-amber-600"
                        bgColor="bg-amber-50"
                    />
                    {hasMatchScore && (
                        <OpportunityStatCard 
                            label="Match Score"
                            value={`${matchScore}%`}
                            icon={Target}
                            color="text-purple-600"
                            bgColor="bg-purple-50"
                        />
                    )}
                    <OpportunityStatCard 
                        label="Type"
                        value={capitalize(grant.opportunity_type) || 'Grant'}
                        icon={OpportunityIcon}
                        color="text-blue-600"
                        bgColor="bg-blue-50"
                    />
                </CardContent>
            </Card>

            {/* Program Details */}
            <Card className="shadow-lg border-0">
                <CardHeader>
                    <CardTitle>Program Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    {grant.program_description && (
                        <div>
                            <h3 className="font-semibold text-slate-800 mb-2">Program Description</h3>
                            <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{grant.program_description}</p>
                        </div>
                    )}
                    
                    {grant.eligibility_summary && (
                        <div className={(grant.program_description ? "pt-4 border-t border-slate-200 " : "")}>
                            <h3 className="font-semibold text-slate-800 mb-2">Eligibility Summary</h3>
                            <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{grant.eligibility_summary}</p>
                        </div>
                    )}
                    
                    {grant.selection_criteria && (
                        <div className={((grant.program_description || grant.eligibility_summary) ? "pt-4 border-t border-slate-200 " : "")}>
                            <h3 className="font-semibold text-slate-800 mb-2">Selection Criteria</h3>
                            <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{grant.selection_criteria}</p>
                        </div>
                    )}

                    {!grant.program_description && !grant.eligibility_summary && !grant.selection_criteria && (
                        <p className="text-slate-500 italic">No detailed program information available.</p>
                    )}
                </CardContent>
            </Card>

            {/* Checklist Modal */}
            {showChecklist && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto">
                        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-center justify-between">
                            <h2 className="text-xl font-bold text-slate-900">Application Checklist</h2>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowChecklist(false)}
                            >
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                        <div className="p-6">
                            <Checklist grantId={grant.id} />
                        </div>
                    </div>
                </div>
            )}

            {/* Submission Assistant Modal */}
            <SubmissionAssistant
                open={showSubmissionAssistant}
                onClose={() => {
                    setShowSubmissionAssistant(false);
                    if (onUpdate) onUpdate();
                }}
                grant={grant}
                organization={organization}
            />
        </div>
    );
}