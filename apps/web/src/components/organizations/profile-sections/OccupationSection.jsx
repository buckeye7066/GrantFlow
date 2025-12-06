import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const OCCUPATION_FIELDS = [
  { field: 'student', label: 'Student', type: 'boolean' },
  { field: 'healthcare_worker', label: 'Healthcare Worker', type: 'boolean' },
  { field: 'ems_worker', label: 'EMS Worker', type: 'boolean' },
  { field: 'educator', label: 'Teacher/Educator', type: 'boolean' },
  { field: 'firefighter', label: 'Firefighter', type: 'boolean' },
  { field: 'law_enforcement', label: 'Law Enforcement', type: 'boolean' },
  { field: 'public_servant', label: 'Public Servant', type: 'boolean' },
  { field: 'clergy', label: 'Clergy/Minister', type: 'boolean' },
  { field: 'missionary', label: 'Missionary', type: 'boolean' },
  { field: 'nonprofit_employee', label: 'Nonprofit Employee', type: 'boolean' },
  { field: 'small_business_owner', label: 'Small Business Owner', type: 'boolean' },
  { field: 'minority_owned_business', label: 'Minority-Owned Business', type: 'boolean' },
  { field: 'women_owned_business', label: 'Women-Owned Business', type: 'boolean' },
  { field: 'union_member', label: 'Union Member', type: 'boolean' },
  { field: 'farmer', label: 'Farmer', type: 'boolean' },
  { field: 'truck_driver', label: 'Truck Driver', type: 'boolean' },
  { field: 'construction_trades_worker', label: 'Construction/Trades', type: 'boolean' },
  { field: 'researcher_scientist', label: 'Researcher/Scientist', type: 'boolean' },
  { field: 'environmental_conservation_worker', label: 'Environmental/Conservation', type: 'boolean' },
  { field: 'energy_sector_worker', label: 'Energy Sector Worker', type: 'boolean' },
  { field: 'artist_musician_cultural_worker', label: 'Artist/Musician/Cultural', type: 'boolean' },
  { field: 'migrant_farmworker', label: 'Migrant/Seasonal Farmworker', type: 'boolean' },
  { field: 'shift_work', label: 'Shift Work / Overtime Exposure', type: 'boolean' },
  { field: 'high_hazard_industry', label: 'High-Hazard Industry', type: 'boolean' },
  { field: 'healthcare_worker_type', label: 'Healthcare Worker Type', type: 'string' },
  { field: 'union_local', label: 'Union Local & Apprenticeship #', type: 'string' },
  { field: 'farmer_acreage', label: 'Farm Acreage', type: 'number' },
];

export default function OccupationSection({ 
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
      console.warn('[OccupationSection] No update handler provided');
    }
  };

  return (
    <Card className="border-purple-200">
      <CardHeader className="bg-purple-50 flex flex-row items-center justify-between">
        <CardTitle className="text-purple-900">Occupation & Work</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Occupation & Work"
            fieldsToExtract={OCCUPATION_FIELDS}
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
                { id: 'student', label: 'Student' },
                { id: 'healthcare_worker', label: 'Healthcare Worker' },
                { id: 'ems_worker', label: 'EMS Worker' },
                { id: 'educator', label: 'Teacher/Educator' },
                { id: 'firefighter', label: 'Firefighter' },
                { id: 'law_enforcement', label: 'Law Enforcement' },
                { id: 'public_servant', label: 'Public Servant' },
                { id: 'clergy', label: 'Clergy/Minister' },
                { id: 'missionary', label: 'Missionary' },
                { id: 'nonprofit_employee', label: 'Nonprofit Employee' },
                { id: 'small_business_owner', label: 'Small Business Owner' },
                { id: 'minority_owned_business', label: 'Minority-Owned Business' },
                { id: 'women_owned_business', label: 'Women-Owned Business' },
                { id: 'union_member', label: 'Union Member' },
                { id: 'farmer', label: 'Farmer' },
                { id: 'truck_driver', label: 'Truck Driver' },
                { id: 'construction_trades_worker', label: 'Construction/Trades' },
                { id: 'researcher_scientist', label: 'Researcher/Scientist' },
                { id: 'environmental_conservation_worker', label: 'Environmental/Conservation' },
                { id: 'energy_sector_worker', label: 'Energy Sector Worker' },
                { id: 'artist_musician_cultural_worker', label: 'Artist/Musician/Cultural' },
                { id: 'migrant_farmworker', label: 'Migrant/Seasonal Farmworker' },
                { id: 'shift_work', label: 'Shift Work / Overtime Exposure' },
                { id: 'high_hazard_industry', label: 'High-Hazard Industry' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div>
              <Label className="text-sm font-medium">Healthcare Worker Type</Label>
              <Input value={currentData.healthcare_worker_type || ''} onChange={(e) => handleFieldUpdate('healthcare_worker_type', e.target.value)} placeholder="e.g., RN, EMT-P, CNA, MD, PTA" />
            </div>
            <div>
              <Label className="text-sm font-medium">Union Local & Apprenticeship #</Label>
              <Input value={currentData.union_local || ''} onChange={(e) => handleFieldUpdate('union_local', e.target.value)} placeholder="e.g., Local 123" />
            </div>
            <div>
              <Label className="text-sm font-medium">Farm Acreage</Label>
              <Input type="number" value={currentData.farmer_acreage || ''} onChange={(e) => handleFieldUpdate('farmer_acreage', parseFloat(e.target.value) || null)} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const occupationBadges = [
                safeOrg.student && <Badge key="student" className="bg-purple-100 text-purple-800">Student</Badge>,
                safeOrg.healthcare_worker && <Badge key="healthcare_worker" className="bg-purple-100 text-purple-800">Healthcare Worker</Badge>,
                safeOrg.ems_worker && <Badge key="ems_worker" className="bg-purple-100 text-purple-800">EMS Worker</Badge>,
                safeOrg.educator && <Badge key="educator" className="bg-purple-100 text-purple-800">Educator</Badge>,
                safeOrg.firefighter && <Badge key="firefighter" className="bg-purple-100 text-purple-800">Firefighter</Badge>,
                safeOrg.law_enforcement && <Badge key="law_enforcement" className="bg-purple-100 text-purple-800">Law Enforcement</Badge>,
                safeOrg.public_servant && <Badge key="public_servant" className="bg-purple-100 text-purple-800">Public Servant</Badge>,
                safeOrg.clergy && <Badge key="clergy" className="bg-purple-100 text-purple-800">Clergy</Badge>,
                safeOrg.missionary && <Badge key="missionary" className="bg-purple-100 text-purple-800">Missionary</Badge>,
                safeOrg.nonprofit_employee && <Badge key="nonprofit_employee" className="bg-purple-100 text-purple-800">Nonprofit Employee</Badge>,
                safeOrg.small_business_owner && <Badge key="small_business_owner" className="bg-purple-100 text-purple-800">Small Business Owner</Badge>,
                safeOrg.minority_owned_business && <Badge key="minority_owned_business" className="bg-purple-100 text-purple-800">Minority-Owned Business</Badge>,
                safeOrg.women_owned_business && <Badge key="women_owned_business" className="bg-purple-100 text-purple-800">Women-Owned Business</Badge>,
                safeOrg.union_member && <Badge key="union_member" className="bg-purple-100 text-purple-800">Union Member</Badge>,
                safeOrg.farmer && <Badge key="farmer" className="bg-purple-100 text-purple-800">Farmer</Badge>,
                safeOrg.truck_driver && <Badge key="truck_driver" className="bg-purple-100 text-purple-800">Truck Driver</Badge>,
                safeOrg.construction_trades_worker && <Badge key="construction_trades_worker" className="bg-purple-100 text-purple-800">Construction/Trades</Badge>,
                safeOrg.researcher_scientist && <Badge key="researcher_scientist" className="bg-purple-100 text-purple-800">Researcher/Scientist</Badge>,
                safeOrg.environmental_conservation_worker && <Badge key="environmental_conservation_worker" className="bg-purple-100 text-purple-800">Environmental/Conservation</Badge>,
                safeOrg.energy_sector_worker && <Badge key="energy_sector_worker" className="bg-purple-100 text-purple-800">Energy Sector Worker</Badge>,
                safeOrg.artist_musician_cultural_worker && <Badge key="artist_musician_cultural_worker" className="bg-purple-100 text-purple-800">Artist/Musician/Cultural</Badge>,
                safeOrg.migrant_farmworker && <Badge key="migrant_farmworker" className="bg-purple-100 text-purple-800">Migrant/Seasonal Farmworker</Badge>,
                safeOrg.shift_work && <Badge key="shift_work" className="bg-purple-100 text-purple-800">Shift Work</Badge>,
                safeOrg.high_hazard_industry && <Badge key="high_hazard_industry" className="bg-purple-100 text-purple-800">High-Hazard Industry</Badge>,
              ].filter(Boolean);
              
              const hasTextFields = safeOrg.healthcare_worker_type || safeOrg.union_local || safeOrg.farmer_acreage;
              
              if (occupationBadges.length === 0 && !hasTextFields) {
                return <p className="text-sm text-slate-500 italic">No occupation information recorded. Click edit to add.</p>;
              }
              
              return <div className="flex flex-wrap gap-2">{occupationBadges}</div>;
            })()}
            {safeOrg.healthcare_worker_type && (
              <div>
                <div className="text-sm font-medium text-slate-700">Healthcare Worker Type</div>
                <div className="text-slate-600">{safeOrg.healthcare_worker_type}</div>
              </div>
            )}
            {safeOrg.union_local && (
              <div>
                <div className="text-sm font-medium text-slate-700">Union Local</div>
                <div className="text-slate-600">{safeOrg.union_local}</div>
              </div>
            )}
            {safeOrg.farmer_acreage && (
              <div>
                <div className="text-sm font-medium text-slate-700">Farm Acreage</div>
                <div className="text-slate-600">{safeOrg.farmer_acreage} acres</div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}