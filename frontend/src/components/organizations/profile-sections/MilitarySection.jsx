import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import EditableTagList from '@/components/shared/EditableTagList';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const MILITARY_FIELDS = [
  { field: 'veteran', label: 'Veteran', type: 'boolean' },
  { field: 'active_duty_military', label: 'Active Duty', type: 'boolean' },
  { field: 'national_guard', label: 'National Guard/Reserve', type: 'boolean' },
  { field: 'disabled_veteran', label: 'Disabled Veteran', type: 'boolean' },
  { field: 'military_spouse', label: 'Military Spouse', type: 'boolean' },
  { field: 'military_dependent', label: 'Military Dependent', type: 'boolean' },
  { field: 'gold_star_family', label: 'Gold Star Family', type: 'boolean' },
  { field: 'dd214_on_file', label: 'DD-214 on File', type: 'boolean' },
  { field: 'vso_representation', label: 'VSO Representation', type: 'boolean' },
  { field: 'post_911_gi_bill', label: 'Post-9/11 GI Bill', type: 'boolean' },
  { field: 'vr_and_e', label: 'VR&E', type: 'boolean' },
  { field: 'champva', label: 'CHAMPVA', type: 'boolean' },
  { field: 'military_branch', label: 'Military Branch & MOS', type: 'string' },
  { field: 'character_of_discharge', label: 'Character of Discharge', type: 'string' },
  { field: 'va_disability_percent', label: 'VA Disability Rating (%)', type: 'number' },
  { field: 'gold_star_relationship', label: 'Gold Star Relationship', type: 'string' },
];

export default function MilitarySection({ 
  organization,
  org, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit,
  onCancel, 
  onSave, 
  onUpdateField,
  onUpdateTemp,
  onUpdateArrayField,
  onUpdate,
  isUpdating 
}) {
  const safeOrg = organization || org || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;
  const handleCancel = onCancelEdit || onCancel;
  
  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[MilitarySection] No update handler provided');
    }
  };
  
  const handleArrayFieldUpdate = (field, value) => {
    if (typeof onUpdateArrayField === 'function') {
      onUpdateArrayField(field, value);
    } else if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    }
  };

  return (
    <Card className="border-indigo-200">
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="text-indigo-900">Military Service</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Military Service"
            fieldsToExtract={MILITARY_FIELDS}
            onUpdate={onUpdate}
            disabled={isUpdating || isEditing}
          />
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isUpdating}>
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
                { id: 'veteran', label: 'Veteran' },
                { id: 'active_duty_military', label: 'Active Duty' },
                { id: 'national_guard', label: 'National Guard/Reserve' },
                { id: 'disabled_veteran', label: 'Disabled Veteran' },
                { id: 'military_spouse', label: 'Military Spouse' },
                { id: 'military_dependent', label: 'Military Dependent' },
                { id: 'gold_star_family', label: 'Gold Star Family' },
                { id: 'dd214_on_file', label: 'DD-214 on File' },
                { id: 'vso_representation', label: 'VSO Representation' },
                { id: 'post_911_gi_bill', label: 'Post-9/11 GI Bill' },
                { id: 'vr_and_e', label: 'VR&E' },
                { id: 'champva', label: 'CHAMPVA' },
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
              <Label className="text-sm font-medium">Military Branch & MOS</Label>
              <Input
                value={currentData.military_branch || ''}
                onChange={(e) => handleFieldUpdate('military_branch', e.target.value)}
                placeholder="e.g., Army - 11B Infantry"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Character of Discharge</Label>
              <Input
                value={currentData.character_of_discharge || ''}
                onChange={(e) => handleFieldUpdate('character_of_discharge', e.target.value)}
                placeholder="e.g., Honorable, General"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">VA Disability Rating (%)</Label>
              <Input
                type="number"
                value={currentData.va_disability_percent || ''}
                onChange={(e) => handleFieldUpdate('va_disability_percent', parseInt(e.target.value) || null)}
                placeholder="e.g., 70"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Gold Star Relationship</Label>
              <Input
                value={currentData.gold_star_relationship || ''}
                onChange={(e) => handleFieldUpdate('gold_star_relationship', e.target.value)}
                placeholder="e.g., Spouse, Child, Parent"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Guard/Reserve Activation Date</Label>
              <Input
                type="date"
                value={currentData.guard_reserve_activation || ''}
                onChange={(e) => handleFieldUpdate('guard_reserve_activation', e.target.value)}
              />
            </div>
            <div className="pt-3 border-t">
              <Label className="text-sm font-medium mb-2 block">Campaign Medals</Label>
              <EditableTagList
                tags={currentData.campaign_medals || []}
                onUpdate={(newTags) => handleArrayFieldUpdate('campaign_medals', newTags)}
                placeholder="Add medals (e.g., OEF, OIF, OND)..."
                disabled={isUpdating}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const militaryBadges = [
                safeOrg.veteran && <Badge key="veteran" className="bg-indigo-100 text-indigo-800">Veteran</Badge>,
                safeOrg.active_duty_military && <Badge key="active_duty" className="bg-indigo-100 text-indigo-800">Active Duty</Badge>,
                safeOrg.national_guard && <Badge key="national_guard" className="bg-indigo-100 text-indigo-800">National Guard/Reserve</Badge>,
                safeOrg.disabled_veteran && <Badge key="disabled_veteran" className="bg-indigo-100 text-indigo-800">Disabled Veteran</Badge>,
                safeOrg.military_spouse && <Badge key="military_spouse" className="bg-indigo-100 text-indigo-800">Military Spouse</Badge>,
                safeOrg.military_dependent && <Badge key="military_dependent" className="bg-indigo-100 text-indigo-800">Military Dependent</Badge>,
                safeOrg.gold_star_family && <Badge key="gold_star" className="bg-indigo-100 text-indigo-800">Gold Star Family</Badge>,
                safeOrg.dd214_on_file && <Badge key="dd214" className="bg-indigo-100 text-indigo-800">DD-214 on File</Badge>,
                safeOrg.vso_representation && <Badge key="vso" className="bg-indigo-100 text-indigo-800">VSO Representation</Badge>,
                safeOrg.post_911_gi_bill && <Badge key="gi_bill" className="bg-indigo-100 text-indigo-800">Post-9/11 GI Bill</Badge>,
                safeOrg.vr_and_e && <Badge key="vr_e" className="bg-indigo-100 text-indigo-800">VR&E</Badge>,
                safeOrg.champva && <Badge key="champva" className="bg-indigo-100 text-indigo-800">CHAMPVA</Badge>,
              ].filter(Boolean);
              
              const hasTextFields = safeOrg.military_branch || safeOrg.va_disability_percent || safeOrg.character_of_discharge || safeOrg.gold_star_relationship || safeOrg.guard_reserve_activation || (safeOrg.campaign_medals || []).length > 0;
              
              if (militaryBadges.length === 0 && !hasTextFields) {
                return <p className="text-sm text-slate-500 italic">No military service information recorded. Click edit to add.</p>;
              }
              
              return <div className="flex flex-wrap gap-2">{militaryBadges}</div>;
            })()}
            {safeOrg.military_branch && (
              <div>
                <div className="text-sm font-medium text-slate-700">Military Branch & MOS</div>
                <div className="text-slate-600">{safeOrg.military_branch}</div>
              </div>
            )}
            {safeOrg.va_disability_percent && (
              <div>
                <div className="text-sm font-medium text-slate-700">VA Disability Rating</div>
                <div className="text-slate-600">{safeOrg.va_disability_percent}%</div>
              </div>
            )}
            {safeOrg.character_of_discharge && (
              <div>
                <div className="text-sm font-medium text-slate-700">Character of Discharge</div>
                <div className="text-slate-600">{safeOrg.character_of_discharge}</div>
              </div>
            )}
            {safeOrg.gold_star_relationship && (
              <div>
                <div className="text-sm font-medium text-slate-700">Gold Star Relationship</div>
                <div className="text-slate-600">{safeOrg.gold_star_relationship}</div>
              </div>
            )}
            {safeOrg.guard_reserve_activation && (
              <div>
                <div className="text-sm font-medium text-slate-700">Guard/Reserve Activation Date</div>
                <div className="text-slate-600">{safeOrg.guard_reserve_activation}</div>
              </div>
            )}
            {(safeOrg.campaign_medals || []).length > 0 && (
              <div className="pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-2">Campaign Medals</div>
                <div className="flex flex-wrap gap-2">
                  {(safeOrg.campaign_medals || []).map((medal, idx) => (
                    <Badge key={idx} variant="outline" className="bg-indigo-50 text-indigo-700">{medal}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}