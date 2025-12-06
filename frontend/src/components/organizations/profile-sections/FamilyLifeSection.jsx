import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const FAMILY_FIELDS = [
  { field: 'single_parent', label: 'Single Parent', type: 'boolean' },
  { field: 'foster_youth', label: 'Foster Youth', type: 'boolean' },
  { field: 'homeless', label: 'Homeless/Housing Insecure', type: 'boolean' },
  { field: 'refugee', label: 'Refugee', type: 'boolean' },
  { field: 'formerly_incarcerated', label: 'Formerly Incarcerated', type: 'boolean' },
  { field: 'caregiver', label: 'Family Caregiver', type: 'boolean' },
  { field: 'orphan', label: 'Orphan', type: 'boolean' },
  { field: 'adopted', label: 'Adopted', type: 'boolean' },
  { field: 'widow_widower', label: 'Widow/Widower', type: 'boolean' },
  { field: 'grandparent_raising_grandchildren', label: 'Grandparent Raising Grandchildren', type: 'boolean' },
  { field: 'first_time_parent', label: 'First-Time Parent', type: 'boolean' },
  { field: 'domestic_violence_survivor', label: 'Domestic Violence Survivor', type: 'boolean' },
  { field: 'trafficking_survivor', label: 'Trafficking Survivor', type: 'boolean' },
  { field: 'disaster_survivor', label: 'Disaster Survivor', type: 'boolean' },
  { field: 'minor_child', label: 'Minor Child', type: 'boolean' },
  { field: 'young_adult', label: 'Young Adult (18-24)', type: 'boolean' },
  { field: 'foster_parent', label: 'Foster Parent', type: 'boolean' },
  { field: 'kinship_care', label: 'Kinship Care', type: 'boolean' },
  { field: 'eviction_risk', label: 'Eviction Risk', type: 'boolean' },
  { field: 'pregnancy_parenting_student', label: 'Pregnancy/Parenting Student', type: 'boolean' },
  { field: 'runaway_homeless_youth', label: 'Runaway/Homeless Youth', type: 'boolean' },
  { field: 'justice_impacted', label: 'Justice-Impacted', type: 'boolean' },
  { field: 'migrant_farmworker', label: 'Migrant Farmworker', type: 'boolean' },
  { field: 'lep', label: 'Limited English Proficiency', type: 'boolean' },
  { field: 'household_size', label: 'Household Size', type: 'number' },
  { field: 'household_income', label: 'Annual Household Income', type: 'number' },
];

export default function FamilyLifeSection({ 
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
  onUpdate,
  isUpdating 
}) {
  const safeOrg = organization || org || {};
  const handleCancel = onCancelEdit || onCancel;
  const currentData = isEditing ? (tempData || {}) : safeOrg;

  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[FamilyLifeSection] No update handler provided');
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader className="bg-blue-50 flex flex-row items-center justify-between">
        <CardTitle className="text-blue-900">Family & Life Situation</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Family & Life Situation"
            fieldsToExtract={FAMILY_FIELDS}
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
                { id: 'single_parent', label: 'Single Parent' },
                { id: 'foster_youth', label: 'Foster Youth' },
                { id: 'homeless', label: 'Homeless/Housing Insecure' },
                { id: 'refugee', label: 'Refugee' },
                { id: 'formerly_incarcerated', label: 'Formerly Incarcerated' },
                { id: 'caregiver', label: 'Family Caregiver' },
                { id: 'orphan', label: 'Orphan' },
                { id: 'adopted', label: 'Adopted' },
                { id: 'widow_widower', label: 'Widow/Widower' },
                { id: 'grandparent_raising_grandchildren', label: 'Grandparent Raising Grandchildren' },
                { id: 'first_time_parent', label: 'First-Time Parent' },
                { id: 'domestic_violence_survivor', label: 'Domestic Violence Survivor' },
                { id: 'trafficking_survivor', label: 'Trafficking Survivor' },
                { id: 'disaster_survivor', label: 'Disaster Survivor' },
                { id: 'minor_child', label: 'Minor Child' },
                { id: 'young_adult', label: 'Young Adult (18-24)' },
                { id: 'foster_parent', label: 'Foster Parent' },
                { id: 'kinship_care', label: 'Kinship Care' },
                { id: 'eviction_risk', label: 'Eviction Risk' },
                { id: 'pregnancy_parenting_student', label: 'Pregnancy/Parenting Student' },
                { id: 'runaway_homeless_youth', label: 'Runaway/Homeless Youth' },
                { id: 'justice_impacted', label: 'Justice-Impacted' },
                { id: 'migrant_farmworker', label: 'Migrant Farmworker' },
                { id: 'lep', label: 'Limited English Proficiency' },
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Household Size</Label>
                <Input
                  type="number"
                  value={currentData.household_size || ''}
                  onChange={(e) => handleFieldUpdate('household_size', parseInt(e.target.value) || null)}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">Annual Household Income</Label>
                <Input
                  type="number"
                  value={currentData.household_income || ''}
                  onChange={(e) => handleFieldUpdate('household_income', parseFloat(e.target.value) || null)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {safeOrg.single_parent && <Badge className="bg-blue-100 text-blue-800">Single Parent</Badge>}
              {safeOrg.foster_youth && <Badge className="bg-blue-100 text-blue-800">Foster Youth</Badge>}
              {safeOrg.homeless && <Badge className="bg-blue-100 text-blue-800">Homeless</Badge>}
              {safeOrg.refugee && <Badge className="bg-blue-100 text-blue-800">Refugee</Badge>}
              {safeOrg.formerly_incarcerated && <Badge className="bg-blue-100 text-blue-800">Formerly Incarcerated</Badge>}
              {safeOrg.caregiver && <Badge className="bg-blue-100 text-blue-800">Caregiver</Badge>}
              {safeOrg.orphan && <Badge className="bg-blue-100 text-blue-800">Orphan</Badge>}
              {safeOrg.adopted && <Badge className="bg-blue-100 text-blue-800">Adopted</Badge>}
              {safeOrg.widow_widower && <Badge className="bg-blue-100 text-blue-800">Widow/Widower</Badge>}
              {safeOrg.grandparent_raising_grandchildren && <Badge className="bg-blue-100 text-blue-800">Grandparent Raising Grandchildren</Badge>}
              {safeOrg.first_time_parent && <Badge className="bg-blue-100 text-blue-800">First-Time Parent</Badge>}
              {safeOrg.domestic_violence_survivor && <Badge className="bg-blue-100 text-blue-800">Domestic Violence Survivor</Badge>}
              {safeOrg.trafficking_survivor && <Badge className="bg-blue-100 text-blue-800">Trafficking Survivor</Badge>}
              {safeOrg.disaster_survivor && <Badge className="bg-blue-100 text-blue-800">Disaster Survivor</Badge>}
              {safeOrg.minor_child && <Badge className="bg-blue-100 text-blue-800">Minor Child</Badge>}
              {safeOrg.young_adult && <Badge className="bg-blue-100 text-blue-800">Young Adult (18-24)</Badge>}
              {safeOrg.foster_parent && <Badge className="bg-blue-100 text-blue-800">Foster Parent</Badge>}
              {safeOrg.kinship_care && <Badge className="bg-blue-100 text-blue-800">Kinship Care</Badge>}
              {safeOrg.eviction_risk && <Badge className="bg-blue-100 text-blue-800">Eviction Risk</Badge>}
              {safeOrg.pregnancy_parenting_student && <Badge className="bg-blue-100 text-blue-800">Pregnancy/Parenting Student</Badge>}
              {safeOrg.runaway_homeless_youth && <Badge className="bg-blue-100 text-blue-800">Runaway/Homeless Youth</Badge>}
              {safeOrg.justice_impacted && <Badge className="bg-blue-100 text-blue-800">Justice-Impacted</Badge>}
              {safeOrg.migrant_farmworker && <Badge className="bg-blue-100 text-blue-800">Migrant Farmworker</Badge>}
              {safeOrg.lep && <Badge className="bg-blue-100 text-blue-800">Limited English Proficiency</Badge>}
            </div>
            {safeOrg.household_size && (
              <div>
                <div className="text-sm font-medium text-slate-700">Household Size</div>
                <div className="text-slate-600">{safeOrg.household_size} people</div>
              </div>
            )}
            {safeOrg.household_income && (
              <div>
                <div className="text-sm font-medium text-slate-700">Annual Household Income</div>
                <div className="text-slate-600">${Number(safeOrg.household_income || 0).toLocaleString()}</div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}