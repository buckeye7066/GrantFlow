import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { format } from 'date-fns';
import { DollarSign, Calendar, Percent, Building2, Heart, GraduationCap, FileCheck, Info, AlertTriangle, CheckCircle, Sparkles, Edit, Target, TrendingUp } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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

const getMatchScoreColor = (score) => {
    if (score >= 80) return { bg: 'from-emerald-500 to-emerald-600', text: 'text-white', label: 'Excellent Match', icon: '🎯' };
    if (score >= 65) return { bg: 'from-green-500 to-green-600', text: 'text-white', label: 'Strong Match', icon: '✨' };
    if (score >= 50) return { bg: 'from-blue-500 to-blue-600', text: 'text-white', label: 'Good Match', icon: '👍' };
    if (score >= 35) return { bg: 'from-amber-500 to-amber-600', text: 'text-white', label: 'Fair Match', icon: '⚠️' };
    return { bg: 'from-slate-400 to-slate-500', text: 'text-white', label: 'Low Match', icon: '❓' };
};

const capitalize = (s) => (s && s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')) || "";

export default function GrantOverview({ grant, organization, onUpdate }) {
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isVerifying, setIsVerifying] = useState(false);
    const [showContactNotes, setShowContactNotes] = useState(false);
    const [contactNotes, setContactNotes] = useState(grant?.contact_notes || '');

    const updateGrantMutation = useMutation({
        mutationFn: (data) => base44.entities.Grant.update(grant.id, data),
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
    
    const hasContactInfo = grant.funder_email || grant.funder_phone || grant.funder_fax || grant.funder_address;
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
  "verification_notes": "brief note about sources and confidence level"
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
                        verification_notes: { type: "string" }
                    }
                }
            });

            const updates = {
                contact_verified: true,
                contact_verified_date: new Date().toISOString(),
                contact_notes: response.verification_notes || 'Re-verified via AI'
            };
            
            if (response.email) updates.funder_email = response.email;
            if (response.phone) updates.funder_phone = response.phone;
            if (response.fax) updates.funder_fax = response.fax;
            if (response.address) updates.funder_address = response.address;

            await updateGrantMutation.mutateAsync(updates);

            toast({
                title: 'Contact Info Updated ✓',
                description: 'Funder contact information has been re-verified and updated.'
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
                        value={grant.award_ceiling ? `$${grant.award_ceiling.toLocaleString()}` : 'N/A'}
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

            {/* Application Method Card */}
            {grant.application_method && (
                <Card className="shadow-lg border-0">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <FileCheck className="w-5 h-5 text-blue-600" />
                            How to Apply
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-start gap-3">
                            <Badge className={`${getApplicationMethodColor(grant.application_method)} px-3 py-1 text-sm`}>
                                {getApplicationMethodLabel(grant.application_method)}
                            </Badge>
                            {grant.application_instructions && (
                                <p className="text-slate-700 flex-1">{grant.application_instructions}</p>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

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