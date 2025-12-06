import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, Heart } from 'lucide-react';
import EditableTagList from '@/components/shared/EditableTagList';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const HEALTH_FIELDS = [
  { field: 'cancer_survivor', label: 'Cancer Survivor', type: 'boolean' },
  { field: 'chronic_illness', label: 'Chronic Illness', type: 'boolean' },
  { field: 'dialysis_patient', label: 'Dialysis Patient', type: 'boolean' },
  { field: 'organ_transplant', label: 'Organ Transplant', type: 'boolean' },
  { field: 'hiv_aids', label: 'HIV/AIDS', type: 'boolean' },
  { field: 'tbi_survivor', label: 'TBI Survivor', type: 'boolean' },
  { field: 'amputee', label: 'Amputee', type: 'boolean' },
  { field: 'neurodivergent', label: 'Neurodivergent', type: 'boolean' },
  { field: 'visual_impairment', label: 'Visual Impairment', type: 'boolean' },
  { field: 'hearing_impairment', label: 'Hearing Impairment', type: 'boolean' },
  { field: 'wheelchair_user', label: 'Wheelchair User', type: 'boolean' },
  { field: 'substance_recovery', label: 'Substance Recovery', type: 'boolean' },
  { field: 'mental_health_condition', label: 'Mental Health', type: 'boolean' },
  { field: 'long_covid', label: 'Long COVID', type: 'boolean' },
  { field: 'maternal_health', label: 'Maternal Health', type: 'boolean' },
  { field: 'hospice_care', label: 'Hospice Care', type: 'boolean' },
  { field: 'rare_disease', label: 'Rare Disease', type: 'boolean' },
  { field: 'behavioral_health_smi', label: 'SMI (Serious Mental Illness)', type: 'boolean' },
  { field: 'behavioral_health_sed', label: 'SED (Serious Emotional Disturbance)', type: 'boolean' },
  { field: 'oud_moud_participant', label: 'OUD/MOUD Participant', type: 'boolean' },
  { field: 'dental_need', label: 'Dental Need', type: 'boolean' },
  { field: 'vision_need', label: 'Vision Need', type: 'boolean' },
  { field: 'hearing_need', label: 'Hearing Need', type: 'boolean' },
  { field: 'assistive_tech_need', label: 'Assistive Technology Need', type: 'boolean' },
  { field: 'hcbs_waiver_eligible', label: 'HCBS Waiver Eligible', type: 'boolean' },
  { field: 'telehealth_capable', label: 'Telehealth Capable', type: 'boolean' },
  { field: 'primary_diagnosis', label: 'Primary Diagnosis', type: 'string' },
  { field: 'cancer_type', label: 'Cancer Type', type: 'string' },
  { field: 'chronic_illness_type', label: 'Chronic Illness Type', type: 'string' },
  { field: 'rare_disease_type', label: 'Rare Disease Type', type: 'string' },
  { field: 'support_needs_level', label: 'Support Needs Level', type: 'string' },
];

export default function HealthDisabilitySection({ 
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
      console.warn('[HealthDisabilitySection] No update handler provided');
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
    <>
      {/* Health & Medical Conditions */}
      <Card className="border-rose-200">
        <CardHeader className="bg-rose-50 flex flex-row items-center justify-between">
          <CardTitle className="text-rose-900">Health & Medical Conditions</CardTitle>
          <div className="flex gap-2">
            <ParseFromDocsButton
              organizationId={safeOrg.id}
              sectionName="Health & Disability"
              fieldsToExtract={HEALTH_FIELDS}
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
                  { id: 'cancer_survivor', label: 'Cancer Survivor' },
                  { id: 'chronic_illness', label: 'Chronic Illness' },
                  { id: 'dialysis_patient', label: 'Dialysis Patient' },
                  { id: 'organ_transplant', label: 'Organ Transplant' },
                  { id: 'hiv_aids', label: 'HIV/AIDS' },
                  { id: 'tbi_survivor', label: 'TBI Survivor' },
                  { id: 'amputee', label: 'Amputee' },
                  { id: 'neurodivergent', label: 'Neurodivergent' },
                  { id: 'visual_impairment', label: 'Visual Impairment' },
                  { id: 'hearing_impairment', label: 'Hearing Impairment' },
                  { id: 'wheelchair_user', label: 'Wheelchair User' },
                  { id: 'substance_recovery', label: 'Substance Recovery' },
                  { id: 'mental_health_condition', label: 'Mental Health' },
                  { id: 'long_covid', label: 'Long COVID' },
                  { id: 'maternal_health', label: 'Maternal Health' },
                  { id: 'hospice_care', label: 'Hospice Care' },
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
              
              <div className="pt-3 border-t">
                <Label htmlFor="primary_diagnosis_edit" className="text-sm font-medium">Primary Diagnosis</Label>
                <Input
                  id="primary_diagnosis_edit"
                  value={currentData.primary_diagnosis || ''}
                  onChange={(e) => handleFieldUpdate('primary_diagnosis', e.target.value)}
                  placeholder="e.g., Type 2 Diabetes Mellitus"
                  className="mt-1"
                />
              </div>

              <div className="pt-3 border-t">
                <Label className="text-sm font-medium mb-2 block">ICD-10 Codes</Label>
                <EditableTagList
                  tags={currentData.icd10_codes || []}
                  onUpdate={(newTags) => handleArrayFieldUpdate('icd10_codes', newTags)}
                  placeholder="Add ICD-10 codes (e.g., E11.9, F84.0)..."
                  disabled={isUpdating}
                />
                <p className="text-xs text-slate-500 mt-1">Medical diagnosis codes for precise matching</p>
              </div>

              <div className="pt-3 border-t">
                <Label className="text-sm font-medium mb-2 block">Disability Types</Label>
                <EditableTagList
                  tags={currentData.disability_type || []}
                  onUpdate={(newTags) => handleArrayFieldUpdate('disability_type', newTags)}
                  placeholder="Add disability types..."
                  disabled={isUpdating}
                />
              </div>
              
              {currentData.cancer_survivor && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 bg-rose-50 rounded">
                  <div>
                    <Label htmlFor="cancer_type" className="text-sm font-medium">Cancer Type</Label>
                    <Input
                      id="cancer_type"
                      value={currentData.cancer_type || ''}
                      onChange={(e) => handleFieldUpdate('cancer_type', e.target.value)}
                      placeholder="e.g., Breast, Lung"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="cancer_diagnosis_year" className="text-sm font-medium">Diagnosis Year</Label>
                    <Input
                      id="cancer_diagnosis_year"
                      type="number"
                      value={currentData.cancer_diagnosis_year || ''}
                      onChange={(e) => handleFieldUpdate('cancer_diagnosis_year', parseInt(e.target.value) || null)}
                      placeholder="2020"
                      className="mt-1"
                    />
                  </div>
                </div>
              )}
              
              {currentData.chronic_illness && (
                <div className="p-3 bg-rose-50 rounded">
                  <Label htmlFor="chronic_illness_type" className="text-sm font-medium">Chronic Illness Type</Label>
                  <Input
                    id="chronic_illness_type"
                    value={currentData.chronic_illness_type || ''}
                    onChange={(e) => handleFieldUpdate('chronic_illness_type', e.target.value)}
                    placeholder="e.g., Diabetes, Heart Disease"
                    className="mt-1"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {currentData.cancer_survivor && <Badge className="bg-rose-100 text-rose-800">Cancer Survivor</Badge>}
                {currentData.chronic_illness && <Badge className="bg-rose-100 text-rose-800">Chronic Illness</Badge>}
                {currentData.dialysis_patient && <Badge className="bg-rose-100 text-rose-800">Dialysis Patient</Badge>}
                {currentData.organ_transplant && <Badge className="bg-rose-100 text-rose-800">Organ Transplant</Badge>}
                {currentData.hiv_aids && <Badge className="bg-rose-100 text-rose-800">HIV/AIDS</Badge>}
                {currentData.tbi_survivor && <Badge className="bg-rose-100 text-rose-800">TBI Survivor</Badge>}
                {currentData.amputee && <Badge className="bg-rose-100 text-rose-800">Amputee</Badge>}
                {currentData.neurodivergent && <Badge className="bg-rose-100 text-rose-800">Neurodivergent</Badge>}
                {currentData.visual_impairment && <Badge className="bg-rose-100 text-rose-800">Visual Impairment</Badge>}
                {currentData.hearing_impairment && <Badge className="bg-rose-100 text-rose-800">Hearing Impairment</Badge>}
                {currentData.wheelchair_user && <Badge className="bg-rose-100 text-rose-800">Wheelchair User</Badge>}
                {currentData.substance_recovery && <Badge className="bg-rose-100 text-rose-800">Substance Recovery</Badge>}
                {currentData.mental_health_condition && <Badge className="bg-rose-100 text-rose-800">Mental Health</Badge>}
                {currentData.long_covid && <Badge className="bg-rose-100 text-rose-800">Long COVID</Badge>}
                {currentData.maternal_health && <Badge className="bg-rose-100 text-rose-800">Maternal Health</Badge>}
                {currentData.hospice_care && <Badge className="bg-rose-100 text-rose-800">Hospice Care</Badge>}
              </div>

              {currentData.primary_diagnosis && (
                <div className="pt-3 border-t">
                  <div className="text-sm font-medium text-slate-700 mb-1">Primary Diagnosis</div>
                  <div className="text-slate-600">{currentData.primary_diagnosis}</div>
                </div>
              )}

              {currentData.icd10_codes && currentData.icd10_codes.length > 0 && (
                <div className="pt-3 border-t">
                  <div className="text-sm font-medium text-slate-700 mb-2">ICD-10 Codes</div>
                  <div className="flex flex-wrap gap-2">
                    {currentData.icd10_codes.map((code, idx) => (
                      <Badge key={idx} variant="outline" className="bg-rose-50 text-rose-700 font-mono">
                        {code}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {currentData.disability_type && currentData.disability_type.length > 0 && (
                <div className="pt-3 border-t">
                  <div className="text-sm font-medium text-slate-700 mb-2">Disability Types</div>
                  <div className="flex flex-wrap gap-2">
                    {currentData.disability_type.map((type, idx) => (
                      <Badge key={idx} variant="outline" className="bg-rose-50 text-rose-700">
                        {type}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              
              {(currentData.cancer_type || currentData.cancer_diagnosis_year || currentData.chronic_illness_type) && (
                <div className="pt-3 border-t space-y-2">
                  {currentData.cancer_type && (
                    <div>
                      <div className="text-sm font-medium text-slate-700 mb-1">Cancer Type</div>
                      <div className="text-slate-600">{currentData.cancer_type}</div>
                    </div>
                  )}
                  {currentData.cancer_diagnosis_year && (
                    <div>
                      <div className="text-sm font-medium text-slate-700 mb-1">Diagnosis Year</div>
                      <div className="text-slate-600">{currentData.cancer_diagnosis_year}</div>
                    </div>
                  )}
                  {currentData.chronic_illness_type && (
                    <div>
                      <div className="text-sm font-medium text-slate-700 mb-1">Chronic Illness Type</div>
                      <div className="text-slate-600">{currentData.chronic_illness_type}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Advanced Health & Disability */}
      <Card className="border-rose-200">
        <CardHeader className="bg-rose-50 flex flex-row items-center justify-between">
          <CardTitle className="text-rose-900">Advanced Health & Disability</CardTitle>
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
        </CardHeader>
        <CardContent className="pt-4">
          {isEditing ? (
            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="rare_disease_edit"
                  checked={currentData.rare_disease || false}
                  onCheckedChange={(checked) => handleFieldUpdate('rare_disease', checked)}
                />
                <Label htmlFor="rare_disease_edit" className="text-sm font-medium">Rare Disease</Label>
              </div>
              {currentData.rare_disease && (
                <div className="pl-6">
                  <Label htmlFor="rare_disease_type_edit" className="text-sm font-medium">Rare Disease Type</Label>
                  <Input
                    id="rare_disease_type_edit"
                    value={currentData.rare_disease_type || ''}
                    onChange={(e) => handleFieldUpdate('rare_disease_type', e.target.value)}
                    placeholder="Name of rare disease"
                    className="mt-1"
                  />
                </div>
              )}
              <div>
                <Label htmlFor="support_needs_level_edit" className="text-sm font-medium">Support Needs Level</Label>
                <Input
                  id="support_needs_level_edit"
                  value={currentData.support_needs_level || ''}
                  onChange={(e) => handleFieldUpdate('support_needs_level', e.target.value)}
                  placeholder="e.g., minimal, moderate, substantial, extensive"
                  className="mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'behavioral_health_smi', label: 'SMI (Serious Mental Illness)' },
                  { id: 'behavioral_health_sed', label: 'SED (Serious Emotional Disturbance)' },
                  { id: 'oud_moud_participant', label: 'OUD/MOUD Participant' },
                  { id: 'dental_need', label: 'Dental Need' },
                  { id: 'vision_need', label: 'Vision Need' },
                  { id: 'hearing_need', label: 'Hearing Need' },
                  { id: 'assistive_tech_need', label: 'Assistive Technology Need' },
                  { id: 'hcbs_waiver_eligible', label: 'HCBS Waiver Eligible' },
                  { id: 'maternal_risk', label: 'Maternal Risk Factors' },
                  { id: 'genetic_testing', label: 'Genetic Testing' },
                  { id: 'clinical_trial_ready', label: 'Clinical Trial Ready' },
                  { id: 'no_pcp', label: 'No Primary Care Provider' },
                  { id: 'telehealth_capable', label: 'Telehealth Capable' },
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
            </div>
          ) : (
            <div className="space-y-3">
              {currentData.support_needs_level && (
                <div>
                  <div className="text-sm font-medium text-slate-700 mb-1">Support Needs Level</div>
                  <div className="text-slate-600">{currentData.support_needs_level}</div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {currentData.rare_disease && <Badge className="bg-rose-100 text-rose-800">Rare Disease</Badge>}
                {currentData.behavioral_health_smi && <Badge className="bg-rose-100 text-rose-800">SMI</Badge>}
                {currentData.behavioral_health_sed && <Badge className="bg-rose-100 text-rose-800">SED</Badge>}
                {currentData.oud_moud_participant && <Badge className="bg-rose-100 text-rose-800">OUD/MOUD</Badge>}
                {currentData.dental_need && <Badge className="bg-rose-100 text-rose-800">Dental Need</Badge>}
                {currentData.vision_need && <Badge className="bg-rose-100 text-rose-800">Vision Need</Badge>}
                {currentData.hearing_need && <Badge className="bg-rose-100 text-rose-800">Hearing Need</Badge>}
                {currentData.assistive_tech_need && <Badge className="bg-rose-100 text-rose-800">Assistive Tech Need</Badge>}
                {currentData.hcbs_waiver_eligible && <Badge className="bg-rose-100 text-rose-800">HCBS Waiver Eligible</Badge>}
                {currentData.maternal_risk && <Badge className="bg-rose-100 text-rose-800">Maternal Risk</Badge>}
                {currentData.genetic_testing && <Badge className="bg-rose-100 text-rose-800">Genetic Testing</Badge>}
                {currentData.clinical_trial_ready && <Badge className="bg-rose-100 text-rose-800">Clinical Trial Ready</Badge>}
                {currentData.no_pcp && <Badge className="bg-rose-100 text-rose-800">No PCP</Badge>}
                {currentData.telehealth_capable && <Badge className="bg-rose-100 text-rose-800">Telehealth Capable</Badge>}
              </div>
              {currentData.rare_disease_type && (
                <div className="pt-3 border-t">
                  <div className="text-sm font-medium text-slate-700 mb-1">Rare Disease Type</div>
                  <div className="text-slate-600">{currentData.rare_disease_type}</div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}