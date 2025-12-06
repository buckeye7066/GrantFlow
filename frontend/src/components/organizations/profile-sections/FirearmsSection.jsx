import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, Target } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const FIREARMS_FIELDS = [
  { field: 'gun_owner', label: 'Gun Owner', type: 'boolean' },
  { field: 'concealed_carry_permit', label: 'Concealed Carry Permit', type: 'boolean' },
  { field: 'nra_member', label: 'NRA Member', type: 'boolean' },
  { field: 'nra_certified_instructor', label: 'NRA Certified Instructor', type: 'boolean' },
  { field: 'firearms_safety_instructor', label: 'Firearms Safety Instructor', type: 'boolean' },
  { field: 'second_amendment_advocate', label: 'Second Amendment Advocate', type: 'boolean' },
  { field: 'firearms_industry', label: 'Firearms Industry', type: 'boolean' },
  { field: 'competitive_shooter', label: 'Competitive Shooter', type: 'boolean' },
  { field: 'hunter', label: 'Hunter', type: 'boolean' },
  { field: 'hunting_license_state', label: 'Hunting License State', type: 'string' },
];

export default function FirearmsSection({ 
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

  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[FirearmsSection] No update handler provided');
    }
  };

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[FirearmsSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  return (
    <Card className="border-green-200">
      <CardHeader className="bg-green-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-green-900">
          <Target className="w-5 h-5 text-green-600" />
          Firearms / Second Amendment
        </CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Firearms & 2A"
            fieldsToExtract={FIREARMS_FIELDS}
            onUpdate={handleParsedUpdate}
            disabled={isUpdating || isEditing || !safeOrg.id}
          />
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
                <X className="w-4 h-4" />
              </Button>
              <Button variant="default" size="sm" onClick={onSave} disabled={isUpdating}>
                <Save className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {isEditing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'gun_owner', label: 'Gun Owner / Firearm Owner' },
                { id: 'concealed_carry_permit', label: 'Concealed Carry Permit' },
                { id: 'nra_member', label: 'NRA Member' },
                { id: 'nra_certified_instructor', label: 'NRA Certified Instructor' },
                { id: 'firearms_safety_instructor', label: 'Firearms Safety Instructor' },
                { id: 'second_amendment_advocate', label: 'Second Amendment Advocate' },
                { id: 'firearms_industry', label: 'Works in Firearms Industry' },
                { id: 'competitive_shooter', label: 'Competitive Shooter' },
                { id: 'hunter', label: 'Hunter' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={item.id}
                    checked={currentData[item.id] || false}
                    onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)}
                  />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div>
              <Label className="text-sm font-medium">Hunting License State(s)</Label>
              <Input
                value={currentData.hunting_license_state || ''}
                onChange={(e) => handleFieldUpdate('hunting_license_state', e.target.value)}
                placeholder="e.g., PA, WV, OH"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const firearmBadges = [
                safeOrg.gun_owner && <Badge key="gun_owner" className="bg-green-100 text-green-800">Gun Owner</Badge>,
                safeOrg.concealed_carry_permit && <Badge key="concealed_carry" className="bg-green-100 text-green-800">Concealed Carry Permit</Badge>,
                safeOrg.nra_member && <Badge key="nra_member" className="bg-green-100 text-green-800">NRA Member</Badge>,
                safeOrg.nra_certified_instructor && <Badge key="nra_instructor" className="bg-green-100 text-green-800">NRA Certified Instructor</Badge>,
                safeOrg.firearms_safety_instructor && <Badge key="safety_instructor" className="bg-green-100 text-green-800">Firearms Safety Instructor</Badge>,
                safeOrg.second_amendment_advocate && <Badge key="2a_advocate" className="bg-green-100 text-green-800">2A Advocate</Badge>,
                safeOrg.firearms_industry && <Badge key="firearms_industry" className="bg-green-100 text-green-800">Firearms Industry</Badge>,
                safeOrg.competitive_shooter && <Badge key="competitive_shooter" className="bg-green-100 text-green-800">Competitive Shooter</Badge>,
                safeOrg.hunter && <Badge key="hunter" className="bg-green-100 text-green-800">Hunter</Badge>,
              ].filter(Boolean);
              
              if (firearmBadges.length === 0 && !safeOrg.hunting_license_state) {
                return <p className="text-sm text-slate-500 italic">No firearms/2A information recorded. Click edit to add.</p>;
              }
              
              return <div className="flex flex-wrap gap-2">{firearmBadges}</div>;
            })()}
            {safeOrg.hunting_license_state && (
              <div>
                <div className="text-sm font-medium text-slate-700">Hunting License State(s)</div>
                <div className="text-slate-600">{safeOrg.hunting_license_state}</div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}