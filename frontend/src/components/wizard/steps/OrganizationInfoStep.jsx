import React, { useEffect } from 'react';
import SmartFormField from '../SmartFormField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2 } from 'lucide-react';

/**
 * Organization Info Step - Auto-Populated from Profile
 */
export default function OrganizationInfoStep({ data, onChange, grant, organization, errors }) {
  // Auto-populate on first load
  useEffect(() => {
    if (organization && !data.organization_name) {
      onChange({
        organization_name: organization.name,
        organization_ein: organization.ein || '',
        organization_address: organization.address || '',
        organization_city: organization.city || '',
        organization_state: organization.state || '',
        organization_zip: organization.zip || '',
        organization_phone: organization.phone?.[0] || '',
        organization_website: organization.website || '',
        organization_mission: organization.mission || '',
        annual_budget: organization.annual_budget || '',
        staff_count: organization.staff_count || ''
      });
    }
  }, [organization, data.organization_name, onChange]);

  const handleFieldChange = (fieldName) => (e) => {
    onChange({ [fieldName]: e.target.value });
  };

  return (
    <div className="space-y-6">
      <Alert className="bg-green-50 border-green-200">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <AlertDescription className="text-green-900">
          <strong>✅ Auto-Populated from Profile</strong>
          <p className="text-sm mt-1">
            We've automatically filled in your organization information. Review and update any grant-specific details.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <Label>Legal Organization Name *</Label>
          <Input
            value={data.organization_name || ''}
            onChange={handleFieldChange('organization_name')}
            placeholder="Official registered name"
            className="mt-2"
          />
        </div>

        <div>
          <Label>EIN / Tax ID</Label>
          <Input
            value={data.organization_ein || ''}
            onChange={handleFieldChange('organization_ein')}
            placeholder="XX-XXXXXXX"
            className="mt-2"
          />
        </div>
      </div>

      <div>
        <Label>Street Address *</Label>
        <Input
          value={data.organization_address || ''}
          onChange={handleFieldChange('organization_address')}
          placeholder="123 Main Street"
          className="mt-2"
        />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <div>
          <Label>City *</Label>
          <Input
            value={data.organization_city || ''}
            onChange={handleFieldChange('organization_city')}
            className="mt-2"
          />
        </div>
        <div>
          <Label>State *</Label>
          <Input
            value={data.organization_state || ''}
            onChange={handleFieldChange('organization_state')}
            placeholder="TN"
            className="mt-2"
          />
        </div>
        <div>
          <Label>ZIP Code *</Label>
          <Input
            value={data.organization_zip || ''}
            onChange={handleFieldChange('organization_zip')}
            placeholder="37403"
            className="mt-2"
          />
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <Label>Phone Number</Label>
          <Input
            value={data.organization_phone || ''}
            onChange={handleFieldChange('organization_phone')}
            placeholder="(423) 555-0100"
            className="mt-2"
          />
        </div>
        <div>
          <Label>Website</Label>
          <Input
            value={data.organization_website || ''}
            onChange={handleFieldChange('organization_website')}
            placeholder="https://..."
            className="mt-2"
          />
        </div>
      </div>

      <SmartFormField
        label="Organization Mission Statement"
        fieldName="organization_mission"
        value={data.organization_mission}
        onChange={handleFieldChange('organization_mission')}
        questionType="general"
        wordLimit={150}
        placeholder="Brief mission statement..."
        multiline={true}
        organizationId={organization?.id}
        grantId={grant?.id}
        helpText="Concise statement of your organization's purpose"
        showAI={true}
      />

      <SmartFormField
        label="Organization History & Background"
        fieldName="organization_history"
        value={data.organization_history}
        onChange={handleFieldChange('organization_history')}
        questionType="organizational_capacity"
        wordLimit={300}
        placeholder="Brief history of your organization..."
        multiline={true}
        organizationId={organization?.id}
        grantId={grant?.id}
        helpText="When founded, major accomplishments, growth over time"
        showAI={true}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <Label>Annual Operating Budget</Label>
          <Input
            type="number"
            value={data.annual_budget || ''}
            onChange={handleFieldChange('annual_budget')}
            placeholder="500000"
            className="mt-2"
          />
        </div>
        <div>
          <Label>Number of Staff</Label>
          <Input
            type="number"
            value={data.staff_count || ''}
            onChange={handleFieldChange('staff_count')}
            placeholder="12"
            className="mt-2"
          />
        </div>
      </div>
    </div>
  );
}