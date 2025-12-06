import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, Sparkles, Loader2 } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

const DEMOGRAPHICS_FIELDS = [
  { field: 'african_american', label: 'African American / Black', type: 'boolean' },
  { field: 'hispanic_latino', label: 'Hispanic / Latino', type: 'boolean' },
  { field: 'asian_american', label: 'Asian American', type: 'boolean' },
  { field: 'pacific_islander', label: 'Pacific Islander / Native Hawaiian', type: 'boolean' },
  { field: 'native_american', label: 'Native American / Alaska Native', type: 'boolean' },
  { field: 'middle_eastern', label: 'Middle Eastern / North African', type: 'boolean' },
  { field: 'white_caucasian', label: 'White / Caucasian', type: 'boolean' },
  { field: 'multiracial', label: 'Multiracial / Mixed Heritage', type: 'boolean' },
  { field: 'appalachian_white', label: 'Appalachian White', type: 'boolean' },
  { field: 'jewish_heritage', label: 'Jewish Heritage', type: 'boolean' },
  { field: 'irish_heritage', label: 'Irish Heritage', type: 'boolean' },
  { field: 'italian_heritage', label: 'Italian Heritage', type: 'boolean' },
  { field: 'polish_heritage', label: 'Polish Heritage', type: 'boolean' },
  { field: 'greek_heritage', label: 'Greek Heritage', type: 'boolean' },
  { field: 'armenian_heritage', label: 'Armenian Heritage', type: 'boolean' },
  { field: 'cajun_creole_heritage', label: 'Cajun / Creole Heritage', type: 'boolean' },
  { field: 'lgbtq', label: 'LGBTQ+', type: 'boolean' },
  { field: 'good_credit_score', label: 'Good Credit Score (700+)', type: 'boolean' },
  { field: 'new_immigrant', label: 'New Immigrant (within 5 years)', type: 'boolean' },
  { field: 'lep', label: 'Limited English Proficiency', type: 'boolean' },
  { field: 'minor_child', label: 'Minor Child (Under 18)', type: 'boolean' },
  { field: 'young_adult', label: 'Young Adult (18-24)', type: 'boolean' },
  { field: 'senior_55_plus', label: 'Senior 55+', type: 'boolean' },
  { field: 'senior_62_plus', label: 'Senior 62+', type: 'boolean' },
  { field: 'senior_65_plus', label: 'Senior 65+', type: 'boolean' },
  { field: 'tribal_affiliation', label: 'Tribal Affiliation', type: 'string' },
  { field: 'immigration_status', label: 'Immigration Status', type: 'string' },
];

export default function DemographicsSection({ 
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
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  // Handle field updates - support both onUpdateField and onUpdateTemp
  const handleFieldUpdate = (field, value) => {
    console.log('[DemographicsSection] handleFieldUpdate:', field, value);
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[DemographicsSection] No update handler available for field:', field);
    }
  };

  // AI Suggest demographics based on profile
  const handleAISuggest = async () => {
    const invokeLLM = base44?.integrations?.Core?.InvokeLLM;
    if (!invokeLLM) {
      toast({ variant: 'destructive', title: 'Error', description: 'AI service unavailable.' });
      return;
    }

    setIsGenerating(true);
    try {
      const context = [
        safeOrg.name && `Name: ${safeOrg.name}`,
        safeOrg.date_of_birth && `Date of Birth: ${safeOrg.date_of_birth}`,
        safeOrg.age && `Age: ${safeOrg.age}`,
        safeOrg.mission && `Bio/Mission: ${safeOrg.mission}`,
        safeOrg.target_population && `Background: ${safeOrg.target_population}`,
        safeOrg.special_circumstances && `Special Circumstances: ${safeOrg.special_circumstances}`,
        safeOrg.city && `City: ${safeOrg.city}`,
        safeOrg.state && `State: ${safeOrg.state}`,
      ].filter(Boolean).join('\n');

      const response = await invokeLLM({
        prompt: `Based on this profile, suggest likely demographic characteristics that may apply. Only suggest what seems likely based on the information provided. Return true/false for each boolean field.

PROFILE:
${context}

Analyze the profile and return demographic flags that seem likely to apply.`,
        response_json_schema: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'object',
              properties: {
                african_american: { type: 'boolean' },
                hispanic_latino: { type: 'boolean' },
                asian_american: { type: 'boolean' },
                pacific_islander: { type: 'boolean' },
                native_american: { type: 'boolean' },
                middle_eastern: { type: 'boolean' },
                white_caucasian: { type: 'boolean' },
                multiracial: { type: 'boolean' },
                senior_55_plus: { type: 'boolean' },
                senior_62_plus: { type: 'boolean' },
                senior_65_plus: { type: 'boolean' },
                young_adult: { type: 'boolean' },
                minor_child: { type: 'boolean' },
              }
            }
          },
          required: ['suggestions']
        }
      });

      if (response?.suggestions) {
        // Filter to only true values
        const trueValues = Object.entries(response.suggestions)
          .filter(([_, v]) => v === true)
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
        
        if (Object.keys(trueValues).length > 0) {
          if (onUpdate && safeOrg.id) {
            onUpdate({ id: safeOrg.id, data: trueValues });
            toast({ title: '✨ Demographics Suggested', description: `Set ${Object.keys(trueValues).length} demographic flags based on profile.` });
          }
        } else {
          toast({ title: 'No Suggestions', description: 'Could not determine demographics from the profile. Please fill in manually.' });
        }
      }
    } catch (error) {
      console.error('[DemographicsSection] AI suggest error:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate suggestions.' });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Card className="border-amber-200" id="demographics-section">
      <CardHeader className="bg-amber-50 flex flex-row items-center justify-between">
        <CardTitle className="text-amber-900">Demographics & Background</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Demographics"
            fieldsToExtract={DEMOGRAPHICS_FIELDS}
            onUpdate={onUpdate}
            disabled={isUpdating || isEditing}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleAISuggest}
            disabled={isGenerating || isUpdating}
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-1" />
            )}
            AI Suggest
          </Button>
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
            <h4 className="font-semibold text-sm">Race/Ethnicity</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'african_american', label: 'African American / Black' },
                { id: 'hispanic_latino', label: 'Hispanic / Latino' },
                { id: 'asian_american', label: 'Asian American' },
                { id: 'pacific_islander', label: 'Pacific Islander / Native Hawaiian' },
                { id: 'native_american', label: 'Native American / Alaska Native' },
                { id: 'middle_eastern', label: 'Middle Eastern / North African' },
                { id: 'white_caucasian', label: 'White / Caucasian' },
                { id: 'multiracial', label: 'Multiracial / Mixed Heritage' },
                { id: 'appalachian_white', label: 'Appalachian White' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div>
              <Label className="text-sm font-medium">Tribal Affiliation</Label>
              <Input value={currentData.tribal_affiliation || ''} onChange={(e) => handleFieldUpdate('tribal_affiliation', e.target.value)} placeholder="Name of tribe" />
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Cultural/Ethnic Heritage</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'jewish_heritage', label: 'Jewish Heritage' },
                { id: 'irish_heritage', label: 'Irish Heritage' },
                { id: 'italian_heritage', label: 'Italian Heritage' },
                { id: 'polish_heritage', label: 'Polish Heritage' },
                { id: 'greek_heritage', label: 'Greek Heritage' },
                { id: 'armenian_heritage', label: 'Armenian Heritage' },
                { id: 'cajun_creole_heritage', label: 'Cajun / Creole Heritage' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Other Demographics</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'lgbtq', label: 'LGBTQ+' },
                { id: 'good_credit_score', label: 'Good Credit Score (700+)' },
                { id: 'new_immigrant', label: 'New Immigrant (within 5 years)' },
                { id: 'lep', label: 'Limited English Proficiency' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>

            <div>
              <Label className="text-sm font-medium">Immigration Status</Label>
              <select className="w-full p-2 border rounded" value={currentData.immigration_status || ''} onChange={(e) => handleFieldUpdate('immigration_status', e.target.value)}>
                <option value="">Select...</option>
                <option value="us_citizen">U.S. Citizen</option>
                <option value="permanent_resident">Permanent Resident (Green Card)</option>
                <option value="refugee">Refugee</option>
                <option value="asylee">Asylee</option>
                <option value="daca">DACA Recipient</option>
                <option value="visa_holder">Visa Holder</option>
                <option value="new_immigrant">New Immigrant</option>
                <option value="other">Other</option>
              </select>
            </div>

            <h4 className="font-semibold text-sm pt-3 border-t">Age Categories</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'minor_child', label: 'Minor Child (Under 18)' },
                { id: 'young_adult', label: 'Young Adult (18-24)' },
                { id: 'senior_55_plus', label: 'Senior 55+' },
                { id: 'senior_62_plus', label: 'Senior 62+' },
                { id: 'senior_65_plus', label: 'Senior 65+' },
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
            <div className="flex flex-wrap gap-2">
              {/* Race/Ethnicity */}
              {safeOrg.african_american && <Badge className="bg-amber-100 text-amber-800">African American / Black</Badge>}
              {safeOrg.hispanic_latino && <Badge className="bg-amber-100 text-amber-800">Hispanic / Latino</Badge>}
              {safeOrg.asian_american && <Badge className="bg-amber-100 text-amber-800">Asian American</Badge>}
              {safeOrg.pacific_islander && <Badge className="bg-amber-100 text-amber-800">Pacific Islander / Native Hawaiian</Badge>}
              {safeOrg.native_american && <Badge className="bg-amber-100 text-amber-800">Native American / Alaska Native</Badge>}
              {safeOrg.middle_eastern && <Badge className="bg-amber-100 text-amber-800">Middle Eastern / North African</Badge>}
              {safeOrg.white_caucasian && <Badge className="bg-amber-100 text-amber-800">White / Caucasian</Badge>}
              {safeOrg.multiracial && <Badge className="bg-amber-100 text-amber-800">Multiracial / Mixed Heritage</Badge>}
              {safeOrg.appalachian_white && <Badge className="bg-amber-100 text-amber-800">Appalachian White</Badge>}
              {/* Cultural/Ethnic Heritage */}
              {safeOrg.jewish_heritage && <Badge className="bg-purple-100 text-purple-800">Jewish Heritage</Badge>}
              {safeOrg.irish_heritage && <Badge className="bg-purple-100 text-purple-800">Irish Heritage</Badge>}
              {safeOrg.italian_heritage && <Badge className="bg-purple-100 text-purple-800">Italian Heritage</Badge>}
              {safeOrg.polish_heritage && <Badge className="bg-purple-100 text-purple-800">Polish Heritage</Badge>}
              {safeOrg.greek_heritage && <Badge className="bg-purple-100 text-purple-800">Greek Heritage</Badge>}
              {safeOrg.armenian_heritage && <Badge className="bg-purple-100 text-purple-800">Armenian Heritage</Badge>}
              {safeOrg.cajun_creole_heritage && <Badge className="bg-purple-100 text-purple-800">Cajun / Creole Heritage</Badge>}
              {/* Other Demographics */}
              {safeOrg.lgbtq && <Badge className="bg-pink-100 text-pink-800">LGBTQ+</Badge>}
              {safeOrg.good_credit_score && <Badge className="bg-green-100 text-green-800">Good Credit Score (700+)</Badge>}
              {safeOrg.new_immigrant && <Badge className="bg-blue-100 text-blue-800">New Immigrant</Badge>}
              {safeOrg.lep && <Badge className="bg-blue-100 text-blue-800">Limited English Proficiency</Badge>}
              {/* Age Categories */}
              {safeOrg.minor_child && <Badge className="bg-teal-100 text-teal-800">Minor Child (Under 18)</Badge>}
              {safeOrg.young_adult && <Badge className="bg-teal-100 text-teal-800">Young Adult (18-24)</Badge>}
              {safeOrg.senior_55_plus && <Badge className="bg-teal-100 text-teal-800">Senior 55+</Badge>}
              {safeOrg.senior_62_plus && <Badge className="bg-teal-100 text-teal-800">Senior 62+</Badge>}
              {safeOrg.senior_65_plus && <Badge className="bg-teal-100 text-teal-800">Senior 65+</Badge>}
            </div>
            {safeOrg.tribal_affiliation && (
              <div>
                <div className="text-sm font-medium text-slate-700">Tribal Affiliation</div>
                <div className="text-slate-600">{safeOrg.tribal_affiliation}</div>
              </div>
            )}
            {safeOrg.immigration_status && (
              <div>
                <div className="text-sm font-medium text-slate-700">Immigration Status</div>
                <div className="text-slate-600">{String(safeOrg.immigration_status).replace(/_/g, ' ')}</div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}