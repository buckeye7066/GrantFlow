
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Sparkles, FileText } from 'lucide-react'; // Added FileText
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import client from '@/api/client';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/utils/logger';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'; // Added Select components

export default function GrantForm({ grant, organization, onSubmit, onCancel, isSubmitting }) { // Added organization prop
    const { toast } = useToast();
    const log = React.useMemo(() => createLogger('GrantForm'), []);
    const [formData, setFormData] = useState({
        title: grant?.title || '',
        funder: grant?.funder || '',
        opportunity_type: grant?.opportunity_type || 'grant', // New field
        application_method: grant?.application_method || 'standard', // New field
        application_instructions: grant?.application_instructions || '', // New field
        deadline: grant?.deadline || '', // New field
        amount_max: grant?.amount_max || '', // New field
        amount_min: grant?.amount_min || '', // New field
        application_url: grant?.application_url || '', // Only use canonical column; grant.url is a discovery URL, not an application portal
        eligibility_summary: grant?.eligibility_summary || '',
        program_description: grant?.program_description || '',
        selection_criteria: grant?.selection_criteria || '',
        funder_email: grant?.funder_email || '',
        funder_phone: grant?.funder_phone || '',
        funder_fax: grant?.funder_fax || '',
        funder_address: grant?.funder_address || '',
        status: grant?.status || 'discovered', // New field
        // Outcome fields. Until these existed there was no way for a user to
        // tell the product an application actually resulted in money, so the
        // find -> apply -> submit -> confirmed chain had no terminal record and
        // "funds secured" could never move off zero.
        submitted_date: grant?.submitted_date || '',
        award_date: grant?.award_date || '',
        amount_awarded: grant?.amount_awarded ?? '',
    });
    
    const [isAutofilling, setIsAutofilling] = useState(false);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        // Goal 1: application_url must be a real URL or explicitly absent
        const trimmedUrl = (formData.application_url || '').trim();
        if (trimmedUrl) {
            try {
                const parsed = new URL(trimmedUrl);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    toast({
                        variant: 'destructive',
                        title: 'Invalid Application URL',
                        description: 'The URL must start with http:// or https://'
                    });
                    return;
                }
            } catch {
                toast({
                    variant: 'destructive',
                    title: 'Invalid Application URL',
                    description: 'Please enter a valid URL (e.g. https://grants.example.org/apply) or leave it blank.'
                });
                return;
            }
        }
        // Goal 1: warn (not hard-block) when url is absent so curator is alerted,
// and always submit the field under the canonical key 'application_url'.
const urlExemptMethods = ['auto_fafsa', 'auto_profile', 'nomination', 'invitation', 'no_application'];
const urlRequired = !urlExemptMethods.includes(formData.application_method);
if (!trimmedUrl && urlRequired) {
    toast({
        variant: 'destructive',
        title: 'Application URL Required',
        description: 'An application URL is required for standard opportunities. If no URL exists, choose an application method such as "Automatic via FAFSA" or "No Application Needed".'
    });
    return;
}
if (!trimmedUrl && !urlRequired) {
    toast({
        title: 'No URL — method noted',
        description: `This opportunity uses "${formData.application_method}" — no URL required. Instructions field will guide applicants.`
    });
}
// Outcome fields are optional: send an explicit null for blanks so a cleared
// value actually clears, and never send '' into a DATE/REAL column.
const parsedAward = String(formData.amount_awarded ?? '').trim();
onSubmit({
    ...formData,
    application_url: trimmedUrl || null,
    submitted_date: formData.submitted_date || null,
    award_date: formData.award_date || null,
    amount_awarded: parsedAward === '' ? null : Number(parsedAward),
});
    };

    const handleAutofillContact = async () => {
        if (!formData.funder) {
            toast({
                variant: 'destructive',
                title: 'Funder Name Required',
                description: 'Please enter the funder name first before using AI to find contact info.'
            });
            return;
        }

        setIsAutofilling(true);
        
        try {
            const prompt = `Find contact information for the following funder organization: "${formData.funder}"

${grant?.url ? `Their website/portal is: ${grant.url}` : ''}

Please search the internet and provide the following contact information in JSON format:
{
  "email": "their grants/contact email address",
  "phone": "their phone number",
  "fax": "their fax number if available",
  "address": "their physical mailing address"
}

Return ONLY the JSON object. If you cannot find a specific piece of information, use null for that field.`;

            const response = await client.integrations.Core.InvokeLLM({
                prompt,
                add_context_from_internet: true,
                response_json_schema: {
                    type: "object",
                    properties: {
                        email: { type: ["string", "null"] },
                        phone: { type: ["string", "null"] },
                        fax: { type: ["string", "null"] },
                        address: { type: ["string", "null"] }
                    }
                }
            });

            log.debug('AI contact response', response);

            // Update form with AI suggestions
            const updates = {};
            if (response.email && !formData.funder_email) updates.funder_email = response.email;
            if (response.phone && !formData.funder_phone) updates.funder_phone = response.phone;
            if (response.fax && !formData.funder_fax) updates.funder_fax = response.fax;
            if (response.address && !formData.funder_address) updates.funder_address = response.address;

            if (Object.keys(updates).length > 0) {
                setFormData(prev => ({ ...prev, ...updates }));
                toast({
                    title: 'Contact Info Found! ✨',
                    description: `Found ${Object.keys(updates).length} contact detail(s). Review and edit as needed.`
                });
            } else {
                toast({
                    title: 'No New Information',
                    description: 'Either all fields are filled or AI could not find contact information.'
                });
            }

        } catch (error) {
            console.error('[GrantForm] AI autofill failed:', error);
            toast({
                variant: 'destructive',
                title: 'AI Search Failed',
                description: error.message || 'Could not find contact information'
            });
        } finally {
            setIsAutofilling(false);
        }
    };

    return (
        <Card className="shadow-xl border-0"> {/* Updated styling */}
            <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50"> {/* Updated styling */}
                <CardTitle className="flex items-center gap-2 text-xl"> {/* Updated styling and added flex */}
                    <FileText className="w-6 h-6 text-blue-600" /> {/* Added FileText icon */}
                    {grant ? 'Edit Grant' : 'New Grant'} {/* Dynamic title */}
                </CardTitle>
            </CardHeader>
            <CardContent className="p-6"> {/* Added padding */}
                <form onSubmit={handleSubmit} className="space-y-6"> {/* Wrapped content in form, added space-y */}
                    <div className="grid md:grid-cols-2 gap-6"> {/* Grid layout for top fields */}
                        <div className="space-y-2">
                            <Label htmlFor="title">Title *</Label> {/* Required indicator */}
                            <Input
                                id="title"
                                name="title"
                                value={formData.title}
                                onChange={handleChange}
                                required // Made required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="funder">Funder *</Label> {/* Required indicator */}
                            <Input
                                id="funder"
                                name="funder"
                                value={formData.funder}
                                onChange={handleChange}
                                required // Made required
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="opportunity_type">Opportunity Type</Label>
                            <Select name="opportunity_type" value={formData.opportunity_type} onValueChange={(value) => setFormData({ ...formData, opportunity_type: value })}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select type" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="grant">Grant</SelectItem>
                                    <SelectItem value="scholarship">Scholarship</SelectItem>
                                    <SelectItem value="fellowship">Fellowship</SelectItem>
                                    <SelectItem value="financial_assistance">Financial Assistance</SelectItem>
                                    <SelectItem value="prize">Prize</SelectItem>
                                    <SelectItem value="award">Award</SelectItem>
                                    <SelectItem value="other">Other</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="application_method">Application Method</Label>
                            <Select name="application_method" value={formData.application_method} onValueChange={(value) => setFormData({ ...formData, application_method: value })}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select method" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="standard">Standard Application</SelectItem>
                                    <SelectItem value="auto_fafsa">Automatic via FAFSA</SelectItem>
                                    <SelectItem value="auto_profile">Automatic Profile Match</SelectItem>
                                    <SelectItem value="nomination">Nomination Required</SelectItem>
                                    <SelectItem value="invitation">Invitation Only (will be marked ineligible by default)</SelectItem>
                                    <SelectItem value="no_application">No Application Needed</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2 md:col-span-2">
                            <Label htmlFor="application_instructions">Application Instructions</Label>
                            <Textarea
                                id="application_instructions"
                                name="application_instructions"
                                value={formData.application_instructions}
                                onChange={handleChange}
                                placeholder="E.g., 'Complete your FAFSA by March 1st to be automatically considered' or 'Submit through your university's scholarship portal'"
                                rows={2}
                            />
                            <p className="text-xs text-slate-500">Specific instructions for how to apply for this opportunity</p>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="application_url">Application URL</Label>
                        <Input
                            id="application_url"
                            name="application_url"
                            type="url"
                            placeholder="https://grants.example.org/apply"
                            value={formData.application_url}
                            onChange={handleChange}
                        />
                        <p className="text-xs text-slate-500">Direct link where applicants can apply. Required for the opportunity to be matched.</p>
                    </div>

                    {/* Outcome — only meaningful once the grant exists and has been pursued. */}
                    {grant?.id && (
                        <Card className="border-emerald-200 bg-emerald-50/50">
                            <CardContent className="p-4 space-y-4">
                                <div>
                                    <h3 className="font-semibold text-slate-900">Outcome</h3>
                                    <p className="text-sm text-slate-600">
                                        Record what actually happened. This is what proves the opportunity
                                        turned into money — leave blank until you hear back.
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="space-y-2">
                                        <Label htmlFor="submitted_date">Submitted On</Label>
                                        <Input
                                            id="submitted_date"
                                            name="submitted_date"
                                            type="date"
                                            value={formData.submitted_date}
                                            onChange={handleChange}
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <Label htmlFor="award_date">Award Date</Label>
                                        <Input
                                            id="award_date"
                                            name="award_date"
                                            type="date"
                                            value={formData.award_date}
                                            onChange={handleChange}
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <Label htmlFor="amount_awarded">Amount Awarded ($)</Label>
                                        <Input
                                            id="amount_awarded"
                                            name="amount_awarded"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            placeholder="0.00"
                                            value={formData.amount_awarded}
                                            onChange={handleChange}
                                        />
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* AI-Powered Contact Information Section - Retained */}
                    <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
                        <CardContent className="p-4 space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="font-semibold text-slate-900">Funder Contact Information</h3>
                                    <p className="text-sm text-slate-600">Let AI find the contact details for this funder</p>
                                </div>
                                <Button
                                    type="button"
                                    onClick={handleAutofillContact}
                                    disabled={isAutofilling || !formData.funder}
                                    className="bg-purple-600 hover:bg-purple-700"
                                >
                                    {isAutofilling ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            Searching...
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="w-4 h-4 mr-2" />
                                            Find Contact Info with AI
                                        </>
                                    )}
                                </Button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="funder_email" className="text-base">Funder Email</Label>
                                    <Input 
                                        id="funder_email" 
                                        name="funder_email" 
                                        type="email"
                                        placeholder="grants@funder.org"
                                        value={formData.funder_email} 
                                        onChange={handleChange} 
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="funder_phone" className="text-base">Funder Phone</Label>
                                    <Input 
                                        id="funder_phone" 
                                        name="funder_phone" 
                                        placeholder="(555) 123-4567"
                                        value={formData.funder_phone} 
                                        onChange={handleChange} 
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="funder_fax" className="text-base">Funder Fax</Label>
                                    <Input 
                                        id="funder_fax" 
                                        name="funder_fax" 
                                        placeholder="(555) 123-4568"
                                        value={formData.funder_fax} 
                                        onChange={handleChange} 
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="funder_address" className="text-base">Funder Mailing Address</Label>
                                <Textarea 
                                    id="funder_address" 
                                    name="funder_address" 
                                    placeholder="123 Main St&#10;City, State ZIP"
                                    value={formData.funder_address} 
                                    onChange={handleChange} 
                                    rows={3}
                                />
                            </div>
                        </CardContent>
                    </Card>

                    {/* Existing fields below the contact section */}
                    <div className="space-y-2">
                        <Label htmlFor="program_description" className="text-base">Program Description</Label>
                        <Textarea id="program_description" name="program_description" value={formData.program_description} onChange={handleChange} rows={6} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="eligibility_summary" className="text-base">Eligibility Summary</Label>
                        <Textarea id="eligibility_summary" name="eligibility_summary" value={formData.eligibility_summary} onChange={handleChange} rows={4} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="selection_criteria" className="text-base">Selection Criteria</Label>
                        <Textarea id="selection_criteria" name="selection_criteria" value={formData.selection_criteria} onChange={handleChange} rows={4} />
                    </div>
                
                    <CardFooter className="flex justify-end gap-3 bg-slate-50 p-4 -mx-6 -mb-6 rounded-b-lg border-t"> {/* Adjusted styling */}
                        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isSubmitting}>
                            {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            Save Changes
                        </Button>
                    </CardFooter>
                </form>
            </CardContent>
        </Card>
    );
}
