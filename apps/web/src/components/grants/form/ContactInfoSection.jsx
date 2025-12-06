import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

/**
 * ContactInfoSection - Reusable AI-powered contact info section
 * @param {Object} props
 * @param {Object} props.formData - Current form state
 * @param {Function} props.onChange - Handler for form updates
 * @param {Object} props.errors - Validation errors
 */
export default function ContactInfoSection({ formData, onChange, errors = {} }) {
  const { toast } = useToast();
  const [isAutofilling, setIsAutofilling] = useState(false);

  const handleChange = (field, value) => {
    onChange({ ...formData, [field]: value });
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

${formData.url ? `Their website/portal is: ${formData.url}` : ''}

Please search the internet and provide the following contact information in JSON format:
{
  "email": "their grants/contact email address",
  "phone": "their phone number",
  "fax": "their fax number if available",
  "address": "their physical mailing address"
}

Return ONLY the JSON object. If you cannot find a specific piece of information, use null for that field.`;

      const response = await base44.integrations.Core.InvokeLLM({
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

      console.log('[ContactInfoSection] AI Response:', response);

      // Build updates object
      const updates = {};
      if (response.email && !formData.funder_email) updates.funder_email = response.email;
      if (response.phone && !formData.funder_phone) updates.funder_phone = response.phone;
      if (response.fax && !formData.funder_fax) updates.funder_fax = response.fax;
      if (response.address && !formData.funder_address) updates.funder_address = response.address;

      if (Object.keys(updates).length > 0) {
        onChange({ ...formData, ...updates });
        
        // Log telemetry
        try {
          await base44.integrations.Core.InvokeLLM({
            prompt: `Log telemetry: grant_contact_autofill_used for funder "${formData.funder}"`,
            response_json_schema: { type: "object", properties: {} }
          });
        } catch (e) {
          console.warn('[ContactInfoSection] Telemetry logging failed:', e);
        }
        
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
      console.error('[ContactInfoSection] AI autofill failed:', error);
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
                Find Contact Info
              </>
            )}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="funder_email">Funder Email</Label>
            <Input 
              id="funder_email" 
              name="funder_email" 
              type="email"
              placeholder="grants@foundation.org"
              value={formData.funder_email || ''} 
              onChange={(e) => handleChange('funder_email', e.target.value)} 
              className={errors.funder_email ? 'border-red-500' : ''}
            />
            {errors.funder_email && (
              <p className="text-xs text-red-600">{errors.funder_email}</p>
            )}
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="funder_phone">Funder Phone</Label>
            <Input 
              id="funder_phone" 
              name="funder_phone" 
              placeholder="(555) 123-4567"
              value={formData.funder_phone || ''} 
              onChange={(e) => handleChange('funder_phone', e.target.value)} 
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="funder_fax">Funder Fax</Label>
            <Input 
              id="funder_fax" 
              name="funder_fax" 
              placeholder="(555) 123-4568"
              value={formData.funder_fax || ''} 
              onChange={(e) => handleChange('funder_fax', e.target.value)} 
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="funder_address">Funder Mailing Address</Label>
          <Textarea 
            id="funder_address" 
            name="funder_address" 
            placeholder="123 Main Street&#10;Suite 100&#10;City, State 12345"
            value={formData.funder_address || ''} 
            onChange={(e) => handleChange('funder_address', e.target.value)} 
            rows={3}
          />
        </div>
      </CardContent>
    </Card>
  );
}