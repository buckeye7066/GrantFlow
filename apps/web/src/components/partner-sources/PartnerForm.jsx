import React, { useState } from 'react';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

/**
 * Form for creating/editing partner sources
 */
export default function PartnerForm({ partner, onSave, onCancel }) {
  const [formData, setFormData] = useState(partner || {
    name: '',
    org_type: 'foundation',
    api_base_url: '',
    auth_type: 'none',
    auth_secret_name: '',
    contact_email: '',
    status: 'inactive'
  });

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    onSave({ ...formData, id: partner?.id });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Partner Name</Label>
        <Input 
          id="name" 
          value={formData.name} 
          onChange={(e) => handleChange('name', e.target.value)} 
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="org_type">Organization Type</Label>
          <Select value={formData.org_type} onValueChange={(v) => handleChange('org_type', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="university">University</SelectItem>
              <SelectItem value="utility">Utility</SelectItem>
              <SelectItem value="foundation">Foundation</SelectItem>
              <SelectItem value="municipality">Municipality</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <Select value={formData.status} onValueChange={(v) => handleChange('status', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="throttled">Throttled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="api_base_url">API Base URL</Label>
        <Input 
          id="api_base_url" 
          value={formData.api_base_url} 
          onChange={(e) => handleChange('api_base_url', e.target.value)} 
          placeholder="https://api.partner.com" 
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="contact_email">Contact Email</Label>
        <Input 
          id="contact_email" 
          type="email" 
          value={formData.contact_email} 
          onChange={(e) => handleChange('contact_email', e.target.value)} 
          placeholder="contact@partner.com" 
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="auth_type">Auth Type</Label>
          <Select value={formData.auth_type} onValueChange={(v) => handleChange('auth_type', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="api_key">API Key</SelectItem>
              <SelectItem value="oauth2">OAuth2</SelectItem>
              <SelectItem value="signed_url">Signed URL</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="auth_secret_name">Auth Secret Name</Label>
          <Input 
            id="auth_secret_name" 
            value={formData.auth_secret_name} 
            onChange={(e) => handleChange('auth_secret_name', e.target.value)} 
            placeholder="PARTNER_API_KEY" 
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSubmit}>
          Save Partner
        </Button>
      </DialogFooter>
    </div>
  );
}