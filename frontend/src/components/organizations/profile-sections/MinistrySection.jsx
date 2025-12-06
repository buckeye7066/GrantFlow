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

const MINISTRY_FIELDS = [
  { field: 'denominational_affiliation', label: 'Denominational Affiliation', type: 'string' },
  { field: 'clergy_credential_level', label: 'Clergy Credential Level', type: 'string' },
  { field: 'years_in_ministry', label: 'Years in Ministry', type: 'number' },
  { field: 'pastoral_assignment_type', label: 'Pastoral Assignment Type', type: 'string' },
  { field: 'statement_of_faith', label: 'Statement of Faith', type: 'boolean' },
  { field: 'non_proselytizing_policy', label: 'Non-Proselytizing Policy', type: 'boolean' },
  { field: 'ordained_clergy', label: 'Ordained Clergy', type: 'boolean' },
  { field: 'chaplaincy_links', label: 'Chaplaincy Links', type: 'boolean' },
];

export default function MinistrySection({ 
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
      console.warn('[MinistrySection] No update handler provided');
    }
  };

  const handleArrayFieldUpdate = (field, value) => {
    if (typeof onUpdateArrayField === 'function') {
      onUpdateArrayField(field, value);
    } else {
      handleFieldUpdate(field, value);
    }
  };

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[MinistrySection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  return (
    <Card className="border-indigo-200">
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="text-indigo-900">Ministry & Clergy Details</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Ministry & Clergy"
            fieldsToExtract={MINISTRY_FIELDS}
            onUpdate={handleParsedUpdate}
            disabled={isUpdating || isEditing}
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
            <div>
              <Label className="text-sm font-medium">Denominational Affiliation</Label>
              <Input
                value={currentData.denominational_affiliation || ''}
                onChange={(e) => handleFieldUpdate('denominational_affiliation', e.target.value)}
                placeholder="e.g., Southern Baptist, Methodist"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Clergy Credential Level</Label>
              <Input
                value={currentData.clergy_credential_level || ''}
                onChange={(e) => handleFieldUpdate('clergy_credential_level', e.target.value)}
                placeholder="e.g., Ordained, Licensed"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Years in Ministry</Label>
                <Input
                  type="number"
                  value={currentData.years_in_ministry || ''}
                  onChange={(e) => handleFieldUpdate('years_in_ministry', parseInt(e.target.value) || null)}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">Pastoral Assignment Type</Label>
                <Input
                  value={currentData.pastoral_assignment_type || ''}
                  onChange={(e) => handleFieldUpdate('pastoral_assignment_type', e.target.value)}
                  placeholder="e.g., Senior Pastor"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'statement_of_faith', label: 'Statement of Faith on File' },
                { id: 'non_proselytizing_policy', label: 'Non-Proselytizing Policy' },
                { id: 'ordained_clergy', label: 'Ordained Clergy' },
                { id: 'chaplaincy_links', label: 'Chaplaincy Links' },
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
              <Label className="text-sm font-medium mb-2 block">Active Ministries</Label>
              <EditableTagList
                tags={currentData.active_ministries || []}
                onUpdate={(newTags) => handleArrayFieldUpdate('active_ministries', newTags)}
                placeholder="Add ministries..."
                disabled={isUpdating}
              />
            </div>
            <div className="pt-3 border-t">
              <Label className="text-sm font-medium mb-2 block">Facility Assets</Label>
              <EditableTagList
                tags={currentData.facility_assets || []}
                onUpdate={(newTags) => handleArrayFieldUpdate('facility_assets', newTags)}
                placeholder="Add facilities..."
                disabled={isUpdating}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const ministryBadges = [
                safeOrg.ordained_clergy && <Badge key="ordained" className="bg-indigo-100 text-indigo-800">Ordained Clergy</Badge>,
                safeOrg.statement_of_faith && <Badge key="statement" className="bg-indigo-100 text-indigo-800">Statement of Faith</Badge>,
                safeOrg.non_proselytizing_policy && <Badge key="non_proselytizing" className="bg-indigo-100 text-indigo-800">Non-Proselytizing Policy</Badge>,
                safeOrg.chaplaincy_links && <Badge key="chaplaincy" className="bg-indigo-100 text-indigo-800">Chaplaincy Links</Badge>,
              ].filter(Boolean);
              
              const hasTextFields = safeOrg.denominational_affiliation || safeOrg.clergy_credential_level || safeOrg.years_in_ministry || safeOrg.pastoral_assignment_type || (safeOrg.active_ministries || []).length > 0;
              
              if (ministryBadges.length === 0 && !hasTextFields) {
                return <p className="text-sm text-slate-500 italic">No ministry/clergy information recorded. Click edit to add.</p>;
              }
              
              return null;
            })()}
            {safeOrg.denominational_affiliation && (
              <div>
                <div className="text-sm font-medium text-slate-700">Denominational Affiliation</div>
                <div className="text-slate-600">{safeOrg.denominational_affiliation}</div>
              </div>
            )}
            {safeOrg.clergy_credential_level && (
              <div>
                <div className="text-sm font-medium text-slate-700">Clergy Credential Level</div>
                <div className="text-slate-600">{safeOrg.clergy_credential_level}</div>
              </div>
            )}
            {safeOrg.years_in_ministry && (
              <div>
                <div className="text-sm font-medium text-slate-700">Years in Ministry</div>
                <div className="text-slate-600">{safeOrg.years_in_ministry} years</div>
              </div>
            )}
            {safeOrg.pastoral_assignment_type && (
              <div>
                <div className="text-sm font-medium text-slate-700">Pastoral Assignment Type</div>
                <div className="text-slate-600">{safeOrg.pastoral_assignment_type}</div>
              </div>
            )}
            {(() => {
              const ministryBadges = [
                safeOrg.ordained_clergy && <Badge key="ordained" className="bg-indigo-100 text-indigo-800">Ordained Clergy</Badge>,
                safeOrg.statement_of_faith && <Badge key="statement" className="bg-indigo-100 text-indigo-800">Statement of Faith</Badge>,
                safeOrg.non_proselytizing_policy && <Badge key="non_proselytizing" className="bg-indigo-100 text-indigo-800">Non-Proselytizing Policy</Badge>,
                safeOrg.chaplaincy_links && <Badge key="chaplaincy" className="bg-indigo-100 text-indigo-800">Chaplaincy Links</Badge>,
              ].filter(Boolean);
              
              return ministryBadges.length > 0 ? <div className="flex flex-wrap gap-2">{ministryBadges}</div> : null;
            })()}
            {(safeOrg.active_ministries || []).length > 0 && (
              <div className="pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-2">Active Ministries</div>
                <EditableTagList
                  tags={safeOrg.active_ministries || []}
                  onUpdate={(newTags) => onUpdate && safeOrg.id && onUpdate({ id: safeOrg.id, data: { active_ministries: newTags }})}
                  placeholder="Add ministries..."
                  disabled={isUpdating}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}