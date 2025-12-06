import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const HERITAGE_FIELDS = [
  { field: 'jewish_heritage', label: 'Jewish Heritage', type: 'boolean' },
  { field: 'irish_heritage', label: 'Irish Heritage', type: 'boolean' },
  { field: 'italian_heritage', label: 'Italian Heritage', type: 'boolean' },
  { field: 'polish_heritage', label: 'Polish Heritage', type: 'boolean' },
  { field: 'greek_heritage', label: 'Greek Heritage', type: 'boolean' },
  { field: 'armenian_heritage', label: 'Armenian Heritage', type: 'boolean' },
  { field: 'cajun_creole_heritage', label: 'Cajun/Creole Heritage', type: 'boolean' },
  { field: 'pacific_islander', label: 'Pacific Islander', type: 'boolean' },
  { field: 'middle_eastern', label: 'Middle Eastern', type: 'boolean' },
  { field: 'white_caucasian', label: 'White/Caucasian', type: 'boolean' },
  { field: 'multiracial', label: 'Multiracial', type: 'boolean' },
];

export default function CulturalHeritageSection({ 
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

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[CulturalHeritageSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[CulturalHeritageSection] No update handler provided');
    }
  };

  return (
    <Card className="border-pink-200">
      <CardHeader className="bg-pink-50 flex flex-row items-center justify-between">
        <CardTitle className="text-pink-900">Cultural Heritage</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Cultural Heritage"
            fieldsToExtract={HERITAGE_FIELDS}
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
          <div className="grid grid-cols-2 gap-3">
            {[
              { id: 'jewish_heritage', label: 'Jewish Heritage' },
              { id: 'irish_heritage', label: 'Irish Heritage' },
              { id: 'italian_heritage', label: 'Italian Heritage' },
              { id: 'polish_heritage', label: 'Polish Heritage' },
              { id: 'greek_heritage', label: 'Greek Heritage' },
              { id: 'armenian_heritage', label: 'Armenian Heritage' },
              { id: 'cajun_creole_heritage', label: 'Cajun/Creole Heritage' },
              { id: 'pacific_islander', label: 'Pacific Islander' },
              { id: 'middle_eastern', label: 'Middle Eastern' },
              { id: 'white_caucasian', label: 'White/Caucasian' },
              { id: 'multiracial', label: 'Multiracial' },
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
        ) : (
          (() => {
            const heritageBadges = [
              safeOrg.jewish_heritage && <Badge key="jewish" className="bg-pink-100 text-pink-800">Jewish</Badge>,
              safeOrg.irish_heritage && <Badge key="irish" className="bg-pink-100 text-pink-800">Irish</Badge>,
              safeOrg.italian_heritage && <Badge key="italian" className="bg-pink-100 text-pink-800">Italian</Badge>,
              safeOrg.polish_heritage && <Badge key="polish" className="bg-pink-100 text-pink-800">Polish</Badge>,
              safeOrg.greek_heritage && <Badge key="greek" className="bg-pink-100 text-pink-800">Greek</Badge>,
              safeOrg.armenian_heritage && <Badge key="armenian" className="bg-pink-100 text-pink-800">Armenian</Badge>,
              safeOrg.cajun_creole_heritage && <Badge key="cajun" className="bg-pink-100 text-pink-800">Cajun/Creole</Badge>,
              safeOrg.pacific_islander && <Badge key="pacific" className="bg-pink-100 text-pink-800">Pacific Islander</Badge>,
              safeOrg.middle_eastern && <Badge key="middle_eastern" className="bg-pink-100 text-pink-800">Middle Eastern</Badge>,
              safeOrg.white_caucasian && <Badge key="white" className="bg-pink-100 text-pink-800">White/Caucasian</Badge>,
              safeOrg.multiracial && <Badge key="multiracial" className="bg-pink-100 text-pink-800">Multiracial</Badge>,
            ].filter(Boolean);
            
            if (heritageBadges.length === 0) {
              return <p className="text-sm text-slate-500 italic">No cultural heritage recorded. Click edit to add.</p>;
            }
            
            return <div className="flex flex-wrap gap-2">{heritageBadges}</div>;
          })()
        )}
      </CardContent>
    </Card>
  );
}