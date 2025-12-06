import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, Phone, Globe, MapPin, Building2, Edit, X, Save } from 'lucide-react';

export default function ContactInfoSection({ 
  organization, 
  contactMethods = [], 
  editingSection, 
  currentData, 
  isUpdating,
  onStartEdit,
  onCancelEdit,
  onSaveSection,
  onUpdateTempField
}) {
  const safeOrg = organization || {};
  const safeContactMethods = Array.isArray(contactMethods) ? contactMethods : [];
  const safeCurrentData = currentData || {};
  
  const emails = safeContactMethods.filter(c => c?.type === 'email').map(c => c?.value).filter(Boolean);
  const phones = safeContactMethods.filter(c => c?.type === 'phone').map(c => c?.value).filter(Boolean);

  return (
    <Card>
      <CardHeader className="bg-blue-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-blue-900">
          <Mail className="w-5 h-5 text-blue-600" />
          Contact Information
        </CardTitle>
        {editingSection !== 'contact' ? (
          <Button variant="ghost" size="sm" onClick={() => onStartEdit('contact')} disabled={isUpdating}>
            <Edit className="w-4 h-4" />
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
              <X className="w-4 h-4" />
            </Button>
            <Button variant="default" size="sm" onClick={onSaveSection} disabled={isUpdating}>
              <Save className="w-4 h-4" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {editingSection === 'contact' ? (
          <div className="space-y-4">
            <div>
              <Label htmlFor="name_edit" className="text-sm font-medium">Name</Label>
              <Input
                id="name_edit"
                value={safeCurrentData.name || ''}
                onChange={(e) => onUpdateTempField('name', e.target.value)}
                placeholder="Organization or Individual Name"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="website_edit" className="text-sm font-medium">Website</Label>
              <Input
                id="website_edit"
                value={safeCurrentData.website || ''}
                onChange={(e) => onUpdateTempField('website', e.target.value)}
                placeholder="https://example.com"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="address_edit" className="text-sm font-medium">Street Address</Label>
              <Input
                id="address_edit"
                value={safeCurrentData.address || ''}
                onChange={(e) => onUpdateTempField('address', e.target.value)}
                placeholder="123 Main St"
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1">
                <Label htmlFor="city_edit" className="text-sm font-medium">City</Label>
                <Input
                  id="city_edit"
                  value={safeCurrentData.city || ''}
                  onChange={(e) => onUpdateTempField('city', e.target.value)}
                  placeholder="City"
                  className="mt-1"
                />
              </div>
              <div className="col-span-1">
                <Label htmlFor="state_edit" className="text-sm font-medium">State</Label>
                <Input
                  id="state_edit"
                  value={safeCurrentData.state || ''}
                  onChange={(e) => onUpdateTempField('state', e.target.value)}
                  placeholder="TN"
                  className="mt-1"
                />
              </div>
              <div className="col-span-1">
                <Label htmlFor="zip_edit" className="text-sm font-medium">ZIP</Label>
                <Input
                  id="zip_edit"
                  value={safeCurrentData.zip || ''}
                  onChange={(e) => onUpdateTempField('zip', e.target.value)}
                  placeholder="37311"
                  className="mt-1"
                />
              </div>
            </div>
            <div className="mt-4 p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-600 mb-2">
                <strong>Note:</strong> Email and phone are managed through Contact Methods. This form only edits the basic profile fields.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Building2 className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Name</div>
                <div className="text-slate-600">{safeOrg.name || '—'}</div>
              </div>
            </div>

            {emails.length > 0 && (
              <div className="flex items-start gap-3">
                <Mail className="w-4 h-4 mt-1 text-slate-400" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700 mb-1">Email</div>
                  {emails.map((email, idx) => (
                    <a key={idx} href={`mailto:${email}`} className="text-blue-600 hover:underline block">
                      {email}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {phones.length > 0 && (
              <div className="flex items-start gap-3">
                <Phone className="w-4 h-4 mt-1 text-slate-400" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700 mb-1">Phone</div>
                  {phones.map((phone, idx) => (
                    <a key={idx} href={`tel:${phone}`} className="text-blue-600 hover:underline block">
                      {phone}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {safeOrg.website && safeOrg.website !== 'none' && (
              <div className="flex items-start gap-3">
                <Globe className="w-4 h-4 mt-1 text-slate-400" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700 mb-1">Website</div>
                  <a href={safeOrg.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                    {safeOrg.website}
                  </a>
                </div>
              </div>
            )}

            {(safeOrg.address || safeOrg.city || safeOrg.state || safeOrg.zip) && (
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 mt-1 text-slate-400" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700 mb-1">Address</div>
                  <div className="text-slate-600">
                    {safeOrg.address && <div>{safeOrg.address}</div>}
                    {(safeOrg.city || safeOrg.state || safeOrg.zip) && (
                      <div>
                        {safeOrg.city}{safeOrg.city && safeOrg.state && ', '}{safeOrg.state} {safeOrg.zip}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}