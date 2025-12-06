import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, Building2 } from 'lucide-react';
import EditableTagList from '@/components/shared/EditableTagList';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const ORG_DETAILS_FIELDS = [
  { field: 'ein', label: 'EIN (Tax ID)', type: 'string' },
  { field: 'uei', label: 'UEI', type: 'string' },
  { field: 'cage_code', label: 'CAGE Code', type: 'string' },
  { field: 'annual_budget', label: 'Annual Budget', type: 'number' },
  { field: 'staff_count', label: 'Staff Count', type: 'number' },
  { field: 'ntee_code', label: 'NTEE Code', type: 'string' },
  { field: 'sam_registered', label: 'SAM Registered', type: 'boolean' },
  { field: 'grants_gov_account', label: 'Grants.gov Account', type: 'boolean' },
  { field: 'audited_financials', label: 'Audited Financials', type: 'boolean' },
  { field: 'nicra', label: 'NICRA', type: 'boolean' },
  { field: 'faith_based', label: 'Faith-Based', type: 'boolean' },
  { field: 'rural', label: 'Rural', type: 'boolean' },
  { field: 'minority_serving', label: 'Minority-Serving', type: 'boolean' },
  { field: 'c3_public_charity', label: '501(c)(3) Public Charity', type: 'boolean' },
  { field: 'fqhc', label: 'FQHC', type: 'boolean' },
];

export default function OrganizationDetailsSection({ 
  organization, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit, 
  onSave, 
  onUpdateField,
  onUpdateTemp,
  onUpdateArrayField,
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
      console.warn('[OrganizationDetailsSection] No update handler provided');
    }
  };

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[OrganizationDetailsSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader className="bg-blue-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-blue-900">
          <Building2 className="w-5 h-5 text-blue-600" />
          Organization Details
        </CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Organization Details"
            fieldsToExtract={ORG_DETAILS_FIELDS}
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
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label className="text-sm font-medium">EIN (Tax ID)</Label>
                <Input value={currentData.ein || ''} onChange={(e) => handleFieldUpdate('ein', e.target.value)} placeholder="XX-XXXXXXX" />
              </div>
              <div>
                <Label className="text-sm font-medium">UEI</Label>
                <Input value={currentData.uei || ''} onChange={(e) => handleFieldUpdate('uei', e.target.value)} placeholder="12-char UEI" />
              </div>
              <div>
                <Label className="text-sm font-medium">CAGE Code</Label>
                <Input value={currentData.cage_code || ''} onChange={(e) => handleFieldUpdate('cage_code', e.target.value)} placeholder="5-char CAGE" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Annual Budget</Label>
                <Input type="number" value={currentData.annual_budget || ''} onChange={(e) => handleFieldUpdate('annual_budget', parseFloat(e.target.value) || null)} placeholder="$" />
              </div>
              <div>
                <Label className="text-sm font-medium">Staff Count</Label>
                <Input type="number" value={currentData.staff_count || ''} onChange={(e) => handleFieldUpdate('staff_count', parseInt(e.target.value) || null)} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">NTEE Code</Label>
              <Input value={currentData.ntee_code || ''} onChange={(e) => handleFieldUpdate('ntee_code', e.target.value)} placeholder="e.g., P20" />
            </div>
            <div>
              <Label className="text-sm font-medium">Evidence-Based Program Model</Label>
              <Input value={currentData.evidence_based_program || ''} onChange={(e) => handleFieldUpdate('evidence_based_program', e.target.value)} placeholder="e.g., Home Visiting—NFP" />
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Federal Registration & Compliance</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'sam_registered', label: 'SAM.gov Registered' },
                { id: 'grants_gov_account', label: 'Grants.gov Account' },
                { id: 'era_commons_account', label: 'eRA Commons Account' },
                { id: 'state_vendor_registration', label: 'State Vendor Registration' },
                { id: 'charitable_solicitation_registered', label: 'Charitable Solicitation Registered' },
                { id: 'sam_exclusions_check', label: 'SAM Exclusions Check Passed' },
                { id: 'audited_financials', label: 'Audited Financials Available' },
                { id: 'nicra', label: 'NICRA (Negotiated Indirect Cost Rate)' },
                { id: 'hipaa_compliant', label: 'HIPAA Compliant' },
                { id: 'ferpa_compliant', label: 'FERPA Compliant' },
                { id: 'cfr_part_2_compliant', label: '42 CFR Part 2 Compliant' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Single Audit Year</Label>
                <Input value={currentData.single_audit_year || ''} onChange={(e) => handleFieldUpdate('single_audit_year', e.target.value)} placeholder="e.g., 2023" />
              </div>
              <div>
                <Label className="text-sm font-medium">NICRA Rate (%)</Label>
                <Input type="number" step="0.1" value={currentData.nicra_rate || ''} onChange={(e) => handleFieldUpdate('nicra_rate', parseFloat(e.target.value) || null)} />
              </div>
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">General Qualifications</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'faith_based', label: 'Faith-Based Organization' },
                { id: 'rural', label: 'Serves Rural Area' },
                { id: 'minority_serving', label: 'Minority-Serving Organization' },
                { id: 'c3_public_charity', label: '501(c)(3) Public Charity' },
                { id: 'c3_private_foundation', label: '501(c)(3) Private Foundation' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Insurance & Risk Management</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">General Liability Coverage ($)</Label>
                <Input type="number" value={currentData.liability_coverage || ''} onChange={(e) => handleFieldUpdate('liability_coverage', parseFloat(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">GL Limits ($)</Label>
                <Input type="number" value={currentData.insurance_gl_limits || ''} onChange={(e) => handleFieldUpdate('insurance_gl_limits', parseFloat(e.target.value) || null)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'insurance_workers_comp', label: "Workers' Compensation Insurance" },
                { id: 'insurance_cyber', label: 'Cyber Insurance' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Partnerships & MOUs</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'school_district', label: 'Schools/School Districts' },
                { id: 'hospital_clinic', label: 'Hospitals/Health Systems' },
                { id: 'university_college', label: 'Universities/Colleges' },
                { id: 'tribal_government', label: 'Tribal Governments' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={`mou_${item.id}`} checked={(currentData.mou_partnerships || []).includes(item.id)} onCheckedChange={(checked) => {
                    const current = currentData.mou_partnerships || [];
                    const updated = checked ? [...current, item.id] : current.filter(x => x !== item.id);
                    handleFieldUpdate('mou_partnerships', updated);
                  }} />
                  <Label htmlFor={`mou_${item.id}`} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Specialized Organization Types</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'school_district', label: 'School District / Charter School' },
                { id: 'university_college', label: 'University / College' },
                { id: 'hospital_clinic', label: 'Hospital / Clinic / FQHC' },
                { id: 'fqhc', label: 'FQHC' },
                { id: 'tribal_government', label: 'Tribal Government' },
                { id: 'community_action_agency', label: 'Community Action Agency (CAA)' },
                { id: 'cdc_org', label: 'Community Development Corporation' },
                { id: 'housing_authority', label: 'Housing Authority' },
                { id: 'workforce_board', label: 'Workforce Development Board' },
                { id: 'veterans_service_org', label: 'Veterans Service Organization' },
                { id: 'volunteer_fire_ems', label: 'Volunteer Fire/EMS' },
                { id: 'research_institute', label: 'Research Institute / Lab' },
                { id: 'cooperative', label: 'Cooperative' },
                { id: 'cdfi_partner', label: 'CDFI Partner' },
                { id: 'msi_institution', label: 'MSI/HBCU/HSI/TCU' },
                { id: 'rural_health_clinic', label: 'Rural Health Clinic' },
                { id: 'environmental_org', label: 'Environmental/Conservation Org' },
                { id: 'labor_union_org', label: 'Labor Union Organization' },
                { id: 'agricultural_extension', label: 'Agricultural Extension Partner' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Business Certifications</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'business_8a', label: '8(a) Certified' },
                { id: 'sdvosb', label: 'SDVOSB' },
                { id: 'hubzone', label: 'HUBZone Certified' },
                { id: 'dbe', label: 'Disadvantaged Business Enterprise' },
                { id: 'mbe', label: 'Minority Business Enterprise' },
                { id: 'wbe', label: 'Women Business Enterprise' },
                { id: 'sbe', label: 'Small Business Enterprise' },
                { id: 'sbir_sttr_eligible', label: 'SBIR/STTR Eligible' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div>
              <Label className="text-sm font-medium">SBIR/STTR Employee Count</Label>
              <Input type="number" value={currentData.sbir_sttr_employee_count || ''} onChange={(e) => handleFieldUpdate('sbir_sttr_employee_count', parseInt(e.target.value) || null)} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-4">
              {safeOrg.ein && <div><div className="text-sm font-medium text-slate-700">EIN</div><div className="text-slate-600">{safeOrg.ein}</div></div>}
              {safeOrg.uei && <div><div className="text-sm font-medium text-slate-700">UEI</div><div className="text-slate-600">{safeOrg.uei}</div></div>}
              {safeOrg.cage_code && <div><div className="text-sm font-medium text-slate-700">CAGE Code</div><div className="text-slate-600">{safeOrg.cage_code}</div></div>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {safeOrg.annual_budget && <div><div className="text-sm font-medium text-slate-700">Annual Budget</div><div className="text-slate-600">${safeOrg.annual_budget.toLocaleString()}</div></div>}
              {safeOrg.staff_count && <div><div className="text-sm font-medium text-slate-700">Staff Count</div><div className="text-slate-600">{safeOrg.staff_count}</div></div>}
            </div>
            {/* NTEE and Evidence-Based Program */}
            <div className="grid grid-cols-2 gap-4">
              {safeOrg.ntee_code && <div><div className="text-sm font-medium text-slate-700">NTEE Code</div><div className="text-slate-600">{safeOrg.ntee_code}</div></div>}
              {safeOrg.evidence_based_program && <div><div className="text-sm font-medium text-slate-700">Evidence-Based Program</div><div className="text-slate-600">{safeOrg.evidence_based_program}</div></div>}
            </div>
            {/* Federal Registration & Compliance */}
            <div className="flex flex-wrap gap-2">
              {safeOrg.sam_registered && <Badge className="bg-blue-100 text-blue-800">SAM Registered</Badge>}
              {safeOrg.grants_gov_account && <Badge className="bg-blue-100 text-blue-800">Grants.gov</Badge>}
              {safeOrg.era_commons_account && <Badge className="bg-blue-100 text-blue-800">eRA Commons</Badge>}
              {safeOrg.state_vendor_registration && <Badge className="bg-blue-100 text-blue-800">State Vendor</Badge>}
              {safeOrg.charitable_solicitation_registered && <Badge className="bg-blue-100 text-blue-800">Charitable Solicitation</Badge>}
              {safeOrg.sam_exclusions_check && <Badge className="bg-green-100 text-green-800">SAM Exclusions Passed</Badge>}
              {safeOrg.audited_financials && <Badge className="bg-blue-100 text-blue-800">Audited Financials</Badge>}
              {safeOrg.nicra && <Badge className="bg-blue-100 text-blue-800">NICRA</Badge>}
              {safeOrg.hipaa_compliant && <Badge className="bg-green-100 text-green-800">HIPAA Compliant</Badge>}
              {safeOrg.ferpa_compliant && <Badge className="bg-green-100 text-green-800">FERPA Compliant</Badge>}
              {safeOrg.cfr_part_2_compliant && <Badge className="bg-green-100 text-green-800">42 CFR Part 2</Badge>}
            </div>
            {/* Audit Info */}
            {(safeOrg.single_audit_year || safeOrg.nicra_rate) && (
              <div className="grid grid-cols-2 gap-4">
                {safeOrg.single_audit_year && <div><div className="text-sm font-medium text-slate-700">Single Audit Year</div><div className="text-slate-600">{safeOrg.single_audit_year}</div></div>}
                {safeOrg.nicra_rate && <div><div className="text-sm font-medium text-slate-700">NICRA Rate</div><div className="text-slate-600">{safeOrg.nicra_rate}%</div></div>}
              </div>
            )}
            {/* General Qualifications */}
            <div className="flex flex-wrap gap-2">
              {safeOrg.faith_based && <Badge className="bg-purple-100 text-purple-800">Faith-Based</Badge>}
              {safeOrg.rural && <Badge className="bg-purple-100 text-purple-800">Rural</Badge>}
              {safeOrg.minority_serving && <Badge className="bg-purple-100 text-purple-800">Minority-Serving</Badge>}
              {safeOrg.c3_public_charity && <Badge className="bg-purple-100 text-purple-800">501(c)(3) Public Charity</Badge>}
              {safeOrg.c3_private_foundation && <Badge className="bg-purple-100 text-purple-800">501(c)(3) Private Foundation</Badge>}
            </div>
            {/* Insurance */}
            {(safeOrg.liability_coverage || safeOrg.insurance_gl_limits || safeOrg.insurance_workers_comp || safeOrg.insurance_cyber) && (
              <div className="pt-2 border-t">
                <div className="text-sm font-medium text-slate-700 mb-2">Insurance</div>
                <div className="flex flex-wrap gap-2">
                  {safeOrg.liability_coverage && <Badge variant="outline">GL: ${Number(safeOrg.liability_coverage).toLocaleString()}</Badge>}
                  {safeOrg.insurance_gl_limits && <Badge variant="outline">GL Limits: ${Number(safeOrg.insurance_gl_limits).toLocaleString()}</Badge>}
                  {safeOrg.insurance_workers_comp && <Badge className="bg-green-100 text-green-800">Workers' Comp</Badge>}
                  {safeOrg.insurance_cyber && <Badge className="bg-green-100 text-green-800">Cyber Insurance</Badge>}
                </div>
              </div>
            )}
            {/* Specialized Org Types */}
            <div className="flex flex-wrap gap-2">
              {safeOrg.school_district && <Badge className="bg-amber-100 text-amber-800">School District</Badge>}
              {safeOrg.university_college && <Badge className="bg-amber-100 text-amber-800">University/College</Badge>}
              {safeOrg.hospital_clinic && <Badge className="bg-amber-100 text-amber-800">Hospital/Clinic</Badge>}
              {safeOrg.fqhc && <Badge className="bg-amber-100 text-amber-800">FQHC</Badge>}
              {safeOrg.tribal_government && <Badge className="bg-amber-100 text-amber-800">Tribal Government</Badge>}
              {safeOrg.community_action_agency && <Badge className="bg-amber-100 text-amber-800">CAA</Badge>}
              {safeOrg.cdc_org && <Badge className="bg-amber-100 text-amber-800">CDC</Badge>}
              {safeOrg.housing_authority && <Badge className="bg-amber-100 text-amber-800">Housing Authority</Badge>}
              {safeOrg.workforce_board && <Badge className="bg-amber-100 text-amber-800">Workforce Board</Badge>}
              {safeOrg.veterans_service_org && <Badge className="bg-amber-100 text-amber-800">VSO</Badge>}
              {safeOrg.volunteer_fire_ems && <Badge className="bg-amber-100 text-amber-800">Volunteer Fire/EMS</Badge>}
              {safeOrg.research_institute && <Badge className="bg-amber-100 text-amber-800">Research Institute</Badge>}
              {safeOrg.cooperative && <Badge className="bg-amber-100 text-amber-800">Cooperative</Badge>}
              {safeOrg.cdfi_partner && <Badge className="bg-amber-100 text-amber-800">CDFI Partner</Badge>}
              {safeOrg.msi_institution && <Badge className="bg-amber-100 text-amber-800">MSI/HBCU/HSI</Badge>}
              {safeOrg.rural_health_clinic && <Badge className="bg-amber-100 text-amber-800">Rural Health Clinic</Badge>}
              {safeOrg.environmental_org && <Badge className="bg-amber-100 text-amber-800">Environmental Org</Badge>}
              {safeOrg.labor_union_org && <Badge className="bg-amber-100 text-amber-800">Labor Union</Badge>}
              {safeOrg.agricultural_extension && <Badge className="bg-amber-100 text-amber-800">Ag Extension</Badge>}
            </div>
            {/* Business Certifications */}
            <div className="flex flex-wrap gap-2">
              {safeOrg.business_8a && <Badge className="bg-indigo-100 text-indigo-800">8(a) Certified</Badge>}
              {safeOrg.sdvosb && <Badge className="bg-indigo-100 text-indigo-800">SDVOSB</Badge>}
              {safeOrg.hubzone && <Badge className="bg-indigo-100 text-indigo-800">HUBZone</Badge>}
              {safeOrg.dbe && <Badge className="bg-indigo-100 text-indigo-800">DBE</Badge>}
              {safeOrg.mbe && <Badge className="bg-indigo-100 text-indigo-800">MBE</Badge>}
              {safeOrg.wbe && <Badge className="bg-indigo-100 text-indigo-800">WBE</Badge>}
              {safeOrg.sbe && <Badge className="bg-indigo-100 text-indigo-800">SBE</Badge>}
              {safeOrg.sbir_sttr_eligible && <Badge className="bg-indigo-100 text-indigo-800">SBIR/STTR Eligible</Badge>}
            </div>
            {safeOrg.sbir_sttr_employee_count && (
              <div><div className="text-sm font-medium text-slate-700">SBIR/STTR Employee Count</div><div className="text-slate-600">{safeOrg.sbir_sttr_employee_count}</div></div>
            )}
          </div>
        )}

        <div className="mt-4 pt-4 border-t">
          <div className="text-sm font-medium text-slate-700 mb-2">NAICS Codes</div>
          <EditableTagList
            tags={safeOrg.naics_codes || []}
            onUpdate={(newTags) => onUpdate && safeOrg.id && onUpdate({ id: safeOrg.id, data: { naics_codes: newTags }})}
            placeholder="Add NAICS codes..."
            disabled={isUpdating}
          />
        </div>
      </CardContent>
    </Card>
  );
}