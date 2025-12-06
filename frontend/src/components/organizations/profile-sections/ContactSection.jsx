import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, Phone, Globe, MapPin, DollarSign, Users, Award, Building2, Edit, X, Save } from 'lucide-react';
import PHIDocumentUploader from '@/components/uploads/PHIDocumentUploader';

const formatDobAndAge = (rawDob, fallbackAge) => {
  if (!rawDob) {
    if (fallbackAge && typeof fallbackAge === 'number' && fallbackAge > 0 && fallbackAge <= 120) {
      return `${fallbackAge} years old`;
    }
    return '—';
  }

  const trimmed = String(rawDob).trim();
  if (trimmed.length < 10) return trimmed;

  const dobPart = trimmed.slice(0, 10);
  const parts = dobPart.split('/');
  if (parts.length !== 3) return trimmed;

  const mm = Number(parts[0]);
  const dd = Number(parts[1]);
  const yyyy = Number(parts[2]);

  if (isNaN(mm) || isNaN(dd) || isNaN(yyyy)) return trimmed;

  const month = mm - 1;
  const dob = new Date(yyyy, month, dd);

  if (Number.isNaN(dob.getTime())) return trimmed;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const mDiff = today.getMonth() - dob.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  if (age < 0 || age > 120) return dobPart;

  return `${dobPart} (${age} years old)`;
};

export default function ContactSection({ 
  organization, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit, 
  onSave, 
  onUpdateField,
  onUpdateTemp,
  onUpdate,
  isUpdating 
}) {
  const safeOrg = organization || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;
  
  // Use whichever update function is provided - with safety check
  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[ContactSection] No update handler provided for field:', field);
    }
  };

  return (
    <Card>
      <CardHeader className="bg-blue-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-blue-900">
          <Mail className="w-5 h-5 text-blue-600" />
          Contact Information
        </CardTitle>
        <div className="flex gap-2">
          <PHIDocumentUploader organization={safeOrg} onUpdate={onUpdate} disabled={isUpdating} />
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
                <X className="w-4 h-4" />
              </Button>
              <Button variant="default" size="sm" onClick={onSave} disabled={isUpdating}>
                <Save className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {isEditing ? (
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium">Name</Label>
              <Input value={currentData.name || ''} onChange={(e) => handleFieldUpdate('name', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Email</Label>
                <Input type="email" value={currentData.email || ''} onChange={(e) => handleFieldUpdate('email', e.target.value)} />
              </div>
              <div>
                <Label className="text-sm font-medium">Phone</Label>
                <Input value={currentData.phone || ''} onChange={(e) => handleFieldUpdate('phone', e.target.value)} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Website</Label>
              <Input value={currentData.website || ''} onChange={(e) => handleFieldUpdate('website', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Date of Birth</Label>
                <Input type="date" value={currentData.date_of_birth || ''} onChange={(e) => handleFieldUpdate('date_of_birth', e.target.value)} />
              </div>
              <div>
                <Label className="text-sm font-medium">Age</Label>
                <Input type="number" value={currentData.age || ''} onChange={(e) => handleFieldUpdate('age', parseInt(e.target.value) || null)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Social Security Number</Label>
                <Input value={currentData.ssn || ''} onChange={(e) => handleFieldUpdate('ssn', e.target.value)} placeholder="XXX-XX-XXXX" />
              </div>
              <div>
                <Label className="text-sm font-medium">Green Card Number</Label>
                <Input value={currentData.green_card_number || ''} onChange={(e) => handleFieldUpdate('green_card_number', e.target.value)} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Street Address</Label>
              <Input value={currentData.address || ''} onChange={(e) => handleFieldUpdate('address', e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label className="text-sm font-medium">City</Label>
                <Input value={currentData.city || ''} onChange={(e) => handleFieldUpdate('city', e.target.value)} />
              </div>
              <div>
                <Label className="text-sm font-medium">State</Label>
                <Input value={currentData.state || ''} onChange={(e) => handleFieldUpdate('state', e.target.value)} />
              </div>
              <div>
                <Label className="text-sm font-medium">ZIP</Label>
                <Input value={currentData.zip || ''} onChange={(e) => handleFieldUpdate('zip', e.target.value)} />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Building2 className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Name</div>
                <div className="text-slate-600">{safeOrg.name || '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Mail className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Email</div>
                <div className="text-slate-600">{safeOrg.email || '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Phone</div>
                <div className="text-slate-600">{safeOrg.phone || '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Globe className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Website</div>
                <div className="text-slate-600">{safeOrg.website || '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Users className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Date of Birth / Age</div>
                <div className="text-slate-600">{formatDobAndAge(safeOrg.date_of_birth, safeOrg.age)}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <DollarSign className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">SSN</div>
                <div className="text-slate-600">{safeOrg.ssn ? `***-**-${String(safeOrg.ssn).slice(-4)}` : '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Award className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Green Card Number</div>
                <div className="text-slate-600">{safeOrg.green_card_number || '—'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 mt-1 text-slate-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 mb-1">Address</div>
                <div className="text-slate-600">
                  {safeOrg.address || '—'}
                  <br />
                  {safeOrg.city}{safeOrg.city && safeOrg.state && ', '}{safeOrg.state} {safeOrg.zip}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}