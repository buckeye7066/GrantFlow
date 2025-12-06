import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const FINANCIAL_FIELDS = [
  { field: 'household_income', label: 'Household Income', type: 'number' },
  { field: 'household_size', label: 'Household Size', type: 'number' },
  { field: 'percent_ami', label: '% of Area Median Income', type: 'number' },
  { field: 'low_income', label: 'Low Income', type: 'boolean' },
  { field: 'unemployed', label: 'Unemployed', type: 'boolean' },
  { field: 'underemployed', label: 'Underemployed', type: 'boolean' },
  { field: 'displaced_worker', label: 'Displaced Worker', type: 'boolean' },
  { field: 'job_retraining', label: 'Job Retraining', type: 'boolean' },
  { field: 'uninsured', label: 'Uninsured (Health)', type: 'boolean' },
  { field: 'medical_debt', label: 'Medical Debt', type: 'boolean' },
  { field: 'education_debt', label: 'Education Debt', type: 'boolean' },
  { field: 'bankruptcy', label: 'Bankruptcy / Foreclosure', type: 'boolean' },
  { field: 'first_time_homebuyer', label: 'First-Time Homebuyer', type: 'boolean' },
  { field: 'rent_burdened', label: 'Rent-Burdened (>30%)', type: 'boolean' },
  { field: 'severely_rent_burdened', label: 'Severely Rent-Burdened (>50%)', type: 'boolean' },
  { field: 'utility_arrears', label: 'Utility Arrears', type: 'boolean' },
  { field: 'transportation_insecurity', label: 'Transportation Insecurity', type: 'boolean' },
  { field: 'childcare_cost_burden', label: 'Childcare Cost Burden', type: 'boolean' },
  { field: 'recent_income_shock', label: 'Recent Income Shock', type: 'boolean' },
  { field: 'eviction_risk', label: 'Eviction Risk', type: 'boolean' },
];

export default function FinancialSection({ 
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
      console.warn('[FinancialSection] No update handler provided');
    }
  };

  return (
    <Card className="border-orange-200">
      <CardHeader className="bg-orange-50 flex flex-row items-center justify-between">
        <CardTitle className="text-orange-900">Financial & Housing Status</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Financial & Housing"
            fieldsToExtract={FINANCIAL_FIELDS}
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Household Income ($)</Label>
                <Input type="number" value={currentData.household_income || ''} onChange={(e) => handleFieldUpdate('household_income', parseFloat(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">Household Size</Label>
                <Input type="number" value={currentData.household_size || ''} onChange={(e) => handleFieldUpdate('household_size', parseInt(e.target.value) || null)} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">% of Area Median Income</Label>
              <Input type="number" step="0.1" value={currentData.percent_ami || ''} onChange={(e) => handleFieldUpdate('percent_ami', parseFloat(e.target.value) || null)} />
            </div>
            <h4 className="font-semibold text-sm pt-3 border-t">Financial Challenges</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'low_income', label: 'Low Income' },
                { id: 'unemployed', label: 'Unemployed' },
                { id: 'underemployed', label: 'Underemployed' },
                { id: 'displaced_worker', label: 'Displaced Worker' },
                { id: 'job_retraining', label: 'Job Retraining' },
                { id: 'uninsured', label: 'Uninsured (Health)' },
                { id: 'medical_debt', label: 'Medical Debt' },
                { id: 'education_debt', label: 'Education Debt' },
                { id: 'bankruptcy', label: 'Bankruptcy / Foreclosure' },
                { id: 'first_time_homebuyer', label: 'First-Time Homebuyer' },
                { id: 'rent_burdened', label: 'Rent-Burdened (>30%)' },
                { id: 'severely_rent_burdened', label: 'Severely Rent-Burdened (>50%)' },
                { id: 'utility_arrears', label: 'Utility Arrears' },
                { id: 'transportation_insecurity', label: 'Transportation Insecurity' },
                { id: 'childcare_cost_burden', label: 'Childcare Cost Burden' },
                { id: 'recent_income_shock', label: 'Recent Income Shock' },
                { id: 'eviction_risk', label: 'Eviction Risk' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              {safeOrg.household_income && <div><div className="text-sm font-medium text-slate-700">Household Income</div><div className="text-slate-600">${safeOrg.household_income.toLocaleString()}</div></div>}
              {safeOrg.household_size && <div><div className="text-sm font-medium text-slate-700">Household Size</div><div className="text-slate-600">{safeOrg.household_size} people</div></div>}
              {safeOrg.percent_ami && <div><div className="text-sm font-medium text-slate-700">% AMI</div><div className="text-slate-600">{safeOrg.percent_ami}%</div></div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {safeOrg.low_income && <Badge className="bg-orange-100 text-orange-800">Low Income</Badge>}
              {safeOrg.unemployed && <Badge className="bg-orange-100 text-orange-800">Unemployed</Badge>}
              {safeOrg.underemployed && <Badge className="bg-orange-100 text-orange-800">Underemployed</Badge>}
              {safeOrg.displaced_worker && <Badge className="bg-orange-100 text-orange-800">Displaced Worker</Badge>}
              {safeOrg.job_retraining && <Badge className="bg-orange-100 text-orange-800">Job Retraining</Badge>}
              {safeOrg.uninsured && <Badge className="bg-orange-100 text-orange-800">Uninsured</Badge>}
              {safeOrg.medical_debt && <Badge className="bg-orange-100 text-orange-800">Medical Debt</Badge>}
              {safeOrg.education_debt && <Badge className="bg-orange-100 text-orange-800">Education Debt</Badge>}
              {safeOrg.bankruptcy && <Badge className="bg-orange-100 text-orange-800">Bankruptcy</Badge>}
              {safeOrg.first_time_homebuyer && <Badge className="bg-orange-100 text-orange-800">First-Time Homebuyer</Badge>}
              {safeOrg.rent_burdened && <Badge className="bg-orange-100 text-orange-800">Rent-Burdened</Badge>}
              {safeOrg.severely_rent_burdened && <Badge className="bg-orange-100 text-orange-800">Severely Rent-Burdened</Badge>}
              {safeOrg.utility_arrears && <Badge className="bg-orange-100 text-orange-800">Utility Arrears</Badge>}
              {safeOrg.transportation_insecurity && <Badge className="bg-orange-100 text-orange-800">Transportation Insecurity</Badge>}
              {safeOrg.childcare_cost_burden && <Badge className="bg-orange-100 text-orange-800">Childcare Burden</Badge>}
              {safeOrg.recent_income_shock && <Badge className="bg-orange-100 text-orange-800">Recent Income Shock</Badge>}
              {safeOrg.eviction_risk && <Badge className="bg-orange-100 text-orange-800">Eviction Risk</Badge>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}