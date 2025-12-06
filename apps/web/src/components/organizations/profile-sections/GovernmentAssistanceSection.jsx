import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const GOVT_ASSISTANCE_FIELDS = [
  { field: 'medicaid_enrolled', label: 'Medicaid Enrolled', type: 'boolean' },
  { field: 'medicare_recipient', label: 'Medicare Recipient', type: 'boolean' },
  { field: 'ssi_recipient', label: 'SSI (Supplemental Security Income)', type: 'boolean' },
  { field: 'ssdi_recipient', label: 'SSDI (Social Security Disability)', type: 'boolean' },
  { field: 'snap_recipient', label: 'SNAP (Food Stamps)', type: 'boolean' },
  { field: 'tanf_recipient', label: 'TANF', type: 'boolean' },
  { field: 'section8_housing', label: 'Section 8 Housing', type: 'boolean' },
  { field: 'public_housing_resident', label: 'Public Housing Resident', type: 'boolean' },
  { field: 'wic_recipient', label: 'WIC', type: 'boolean' },
  { field: 'chip_recipient', label: 'CHIP', type: 'boolean' },
  { field: 'head_start_participant', label: 'Head Start', type: 'boolean' },
  { field: 'liheap_recipient', label: 'LIHEAP (Energy Assistance)', type: 'boolean' },
  { field: 'lifeline_acp_recipient', label: 'Lifeline/ACP (Internet)', type: 'boolean' },
  { field: 'wioa_services', label: 'WIOA Services', type: 'boolean' },
  { field: 'vocational_rehab', label: 'Vocational Rehabilitation', type: 'boolean' },
  { field: 'eitc_eligible', label: 'EITC Eligible', type: 'boolean' },
  { field: 'ryan_white', label: 'Ryan White HIV/AIDS Program', type: 'boolean' },
  { field: 'medicaid_waiver_program', label: 'Medicaid Waiver Program', type: 'string' },
  { field: 'medicaid_number', label: 'Medicaid Number', type: 'string' },
  { field: 'tenncare_id', label: 'TennCare ID', type: 'string' },
];

export default function GovernmentAssistanceSection({ 
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
      console.warn('[GovernmentAssistanceSection] No update handler provided');
    }
  };

  return (
    <Card className="border-teal-200">
      <CardHeader className="bg-teal-50 flex flex-row items-center justify-between">
        <CardTitle className="text-teal-900">Government Assistance Programs</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Government Assistance"
            fieldsToExtract={GOVT_ASSISTANCE_FIELDS}
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
                { id: 'medicaid_enrolled', label: 'Medicaid Enrolled' },
                { id: 'medicare_recipient', label: 'Medicare Recipient' },
                { id: 'ssi_recipient', label: 'SSI (Supplemental Security Income)' },
                { id: 'ssdi_recipient', label: 'SSDI (Social Security Disability)' },
                { id: 'snap_recipient', label: 'SNAP (Food Stamps)' },
                { id: 'tanf_recipient', label: 'TANF' },
                { id: 'section8_housing', label: 'Section 8 Housing' },
                { id: 'public_housing_resident', label: 'Public Housing Resident' },
                { id: 'wic_recipient', label: 'WIC' },
                { id: 'chip_recipient', label: 'CHIP' },
                { id: 'head_start_participant', label: 'Head Start' },
                { id: 'liheap_recipient', label: 'LIHEAP (Energy Assistance)' },
                { id: 'lifeline_acp_recipient', label: 'Lifeline/ACP (Internet)' },
                { id: 'wioa_services', label: 'WIOA Services' },
                { id: 'vocational_rehab', label: 'Vocational Rehabilitation' },
                { id: 'eitc_eligible', label: 'EITC Eligible' },
                { id: 'ryan_white', label: 'Ryan White HIV/AIDS Program' },
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

            {currentData.medicaid_enrolled && (
              <div className="p-3 bg-teal-50 rounded border border-teal-200">
                <Label htmlFor="medicaid_waiver_program_edit" className="text-sm font-medium">Medicaid Waiver Program</Label>
                <select
                  id="medicaid_waiver_program_edit"
                  className="w-full mt-1 p-2 border rounded"
                  value={currentData.medicaid_waiver_program || ''}
                  onChange={(e) => handleFieldUpdate('medicaid_waiver_program', e.target.value)}
                >
                  <option value="">No waiver program</option>
                  <option value="ecf_choices">ECF CHOICES (TN) - Employment & Community First</option>
                  <option value="katie_beckett">Katie Beckett - Children with Disabilities</option>
                  <option value="self_determination">Self-Determination Waiver</option>
                  <option value="family_support">Family Support Waiver</option>
                  <option value="other">Other Waiver Program</option>
                </select>
                
                <div className="mt-3">
                  <Label htmlFor="medicaid_number_edit" className="text-sm font-medium">Medicaid Number</Label>
                  <Input
                    id="medicaid_number_edit"
                    value={currentData.medicaid_number || ''}
                    onChange={(e) => handleFieldUpdate('medicaid_number', e.target.value)}
                    placeholder="Medicaid ID"
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <div>
              <Label htmlFor="tenncare_id_edit" className="text-sm font-medium">TennCare ID</Label>
              <Input
                id="tenncare_id_edit"
                value={currentData.tenncare_id || ''}
                onChange={(e) => handleFieldUpdate('tenncare_id', e.target.value)}
                placeholder="TennCare ID number"
                className="mt-1"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {currentData.medicaid_enrolled && <Badge className="bg-teal-100 text-teal-800">Medicaid</Badge>}
              {currentData.medicare_recipient && <Badge className="bg-teal-100 text-teal-800">Medicare</Badge>}
              {currentData.ssi_recipient && <Badge className="bg-teal-100 text-teal-800">SSI</Badge>}
              {currentData.ssdi_recipient && <Badge className="bg-teal-100 text-teal-800">SSDI</Badge>}
              {currentData.snap_recipient && <Badge className="bg-teal-100 text-teal-800">SNAP</Badge>}
              {currentData.tanf_recipient && <Badge className="bg-teal-100 text-teal-800">TANF</Badge>}
              {currentData.section8_housing && <Badge className="bg-teal-100 text-teal-800">Section 8</Badge>}
              {currentData.public_housing_resident && <Badge className="bg-teal-100 text-teal-800">Public Housing</Badge>}
              {currentData.wic_recipient && <Badge className="bg-teal-100 text-teal-800">WIC</Badge>}
              {currentData.chip_recipient && <Badge className="bg-teal-100 text-teal-800">CHIP</Badge>}
              {currentData.head_start_participant && <Badge className="bg-teal-100 text-teal-800">Head Start</Badge>}
              {currentData.liheap_recipient && <Badge className="bg-teal-100 text-teal-800">LIHEAP</Badge>}
              {currentData.lifeline_acp_recipient && <Badge className="bg-teal-100 text-teal-800">Lifeline/ACP</Badge>}
              {currentData.wioa_services && <Badge className="bg-teal-100 text-teal-800">WIOA</Badge>}
              {currentData.vocational_rehab && <Badge className="bg-teal-100 text-teal-800">Vocational Rehab</Badge>}
              {currentData.eitc_eligible && <Badge className="bg-teal-100 text-teal-800">EITC Eligible</Badge>}
              {currentData.ryan_white && <Badge className="bg-teal-100 text-teal-800">Ryan White</Badge>}
            </div>

            {currentData.medicaid_waiver_program && currentData.medicaid_waiver_program !== 'none' && (
              <div className="pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-1">Medicaid Waiver Program</div>
                <div className="text-slate-600">
                  {currentData.medicaid_waiver_program === 'ecf_choices' && 'ECF CHOICES (TN) - Employment & Community First'}
                  {currentData.medicaid_waiver_program === 'katie_beckett' && 'Katie Beckett - Children with Disabilities'}
                  {currentData.medicaid_waiver_program === 'self_determination' && 'Self-Determination Waiver'}
                  {currentData.medicaid_waiver_program === 'family_support' && 'Family Support Waiver'}
                  {currentData.medicaid_waiver_program === 'other' && 'Other Waiver Program'}
                </div>
              </div>
            )}

            {(currentData.medicaid_number || currentData.tenncare_id) && (
              <div className="pt-3 border-t space-y-2">
                {currentData.medicaid_number && (
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-1">Medicaid Number</div>
                    <div className="text-slate-600">{currentData.medicaid_number}</div>
                  </div>
                )}
                {currentData.tenncare_id && (
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-1">TennCare ID</div>
                    <div className="text-slate-600">{currentData.tenncare_id}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}