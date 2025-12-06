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

const POLITICAL_FIELDS = [
  { field: 'elected_official', label: 'Elected Official', type: 'boolean' },
  { field: 'political_candidate', label: 'Political Candidate', type: 'boolean' },
  { field: 'party_committee_member', label: 'Party Committee Member', type: 'boolean' },
  { field: 'campaign_volunteer', label: 'Campaign Volunteer', type: 'boolean' },
  { field: 'political_activist', label: 'Political Activist', type: 'boolean' },
  { field: 'municipal_official', label: 'Municipal Official', type: 'boolean' },
  { field: 'county_official', label: 'County Official', type: 'boolean' },
  { field: 'state_official', label: 'State Official', type: 'boolean' },
  { field: 'federal_official', label: 'Federal Official', type: 'boolean' },
  { field: 'campaign_finance_experience', label: 'Campaign Finance Experience', type: 'boolean' },
  { field: 'public_office_held', label: 'Office Held', type: 'string' },
  { field: 'years_in_office', label: 'Years in Office', type: 'number' },
  { field: 'political_party_affiliation', label: 'Political Party', type: 'string' },
  { field: 'civic_engagement_level', label: 'Civic Engagement Level', type: 'string' },
];

export default function PoliticalCivicSection({ 
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
      console.warn('[PoliticalCivicSection] No update handler provided');
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
    console.log('[PoliticalCivicSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  return (
    <Card className="border-indigo-200">
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-indigo-900">
          <Building2 className="w-5 h-5 text-indigo-600" />
          Political / Civic Engagement
        </CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Political & Civic"
            fieldsToExtract={POLITICAL_FIELDS}
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
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'elected_official', label: 'Current/Former Elected Official' },
                { id: 'political_candidate', label: 'Political Candidate' },
                { id: 'party_committee_member', label: 'Party Committee Member' },
                { id: 'campaign_volunteer', label: 'Campaign Volunteer' },
                { id: 'political_activist', label: 'Political Activist/Organizer' },
                { id: 'municipal_official', label: 'Municipal/Local Official' },
                { id: 'county_official', label: 'County Official' },
                { id: 'state_official', label: 'State Official' },
                { id: 'federal_official', label: 'Federal Official' },
                { id: 'campaign_finance_experience', label: 'Campaign Finance Experience' },
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
              <Label className="text-sm font-medium">Office Held</Label>
              <Input
                value={currentData.public_office_held || ''}
                onChange={(e) => handleFieldUpdate('public_office_held', e.target.value)}
                placeholder="e.g., City Council Member, School Board"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Years in Office</Label>
              <Input
                type="number"
                value={currentData.years_in_office || ''}
                onChange={(e) => handleFieldUpdate('years_in_office', parseInt(e.target.value) || null)}
                placeholder="e.g., 4"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Political Party Affiliation</Label>
              <select
                className="w-full p-2 border rounded"
                value={currentData.political_party_affiliation || ''}
                onChange={(e) => handleFieldUpdate('political_party_affiliation', e.target.value)}
              >
                <option value="">Select...</option>
                <option value="none">None / No Affiliation</option>
                <option value="democratic">Democratic</option>
                <option value="republican">Republican</option>
                <option value="independent">Independent</option>
                <option value="libertarian">Libertarian</option>
                <option value="green">Green</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label className="text-sm font-medium">Party Leadership Position</Label>
              <Input
                value={currentData.party_leadership_position || ''}
                onChange={(e) => handleFieldUpdate('party_leadership_position', e.target.value)}
                placeholder="e.g., Chair, Vice-Chair, Treasurer"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Civic Engagement Level</Label>
              <select
                className="w-full p-2 border rounded"
                value={currentData.civic_engagement_level || ''}
                onChange={(e) => handleFieldUpdate('civic_engagement_level', e.target.value)}
              >
                <option value="">Select...</option>
                <option value="none">None</option>
                <option value="voter">Voter</option>
                <option value="volunteer">Volunteer</option>
                <option value="activist">Activist</option>
                <option value="candidate">Candidate</option>
                <option value="official">Elected Official</option>
              </select>
            </div>
            <div className="pt-3 border-t">
              <Label className="text-sm font-medium mb-2 block">Policy Expertise Areas</Label>
              <EditableTagList
                tags={currentData.policy_expertise_areas || []}
                onUpdate={(newTags) => handleArrayFieldUpdate('policy_expertise_areas', newTags)}
                placeholder="Add policy areas..."
                disabled={isUpdating}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const politicalBadges = [
                safeOrg.elected_official && <Badge key="elected_official" className="bg-indigo-100 text-indigo-800">Elected Official</Badge>,
                safeOrg.political_candidate && <Badge key="political_candidate" className="bg-indigo-100 text-indigo-800">Political Candidate</Badge>,
                safeOrg.party_committee_member && <Badge key="party_committee" className="bg-indigo-100 text-indigo-800">Party Committee Member</Badge>,
                safeOrg.campaign_volunteer && <Badge key="campaign_volunteer" className="bg-indigo-100 text-indigo-800">Campaign Volunteer</Badge>,
                safeOrg.political_activist && <Badge key="political_activist" className="bg-indigo-100 text-indigo-800">Political Activist</Badge>,
                safeOrg.municipal_official && <Badge key="municipal_official" className="bg-indigo-100 text-indigo-800">Municipal Official</Badge>,
                safeOrg.county_official && <Badge key="county_official" className="bg-indigo-100 text-indigo-800">County Official</Badge>,
                safeOrg.state_official && <Badge key="state_official" className="bg-indigo-100 text-indigo-800">State Official</Badge>,
                safeOrg.federal_official && <Badge key="federal_official" className="bg-indigo-100 text-indigo-800">Federal Official</Badge>,
                safeOrg.campaign_finance_experience && <Badge key="campaign_finance" className="bg-indigo-100 text-indigo-800">Campaign Finance Exp.</Badge>,
              ].filter(Boolean);
              
              const hasTextFields = safeOrg.public_office_held || safeOrg.years_in_office || safeOrg.political_party_affiliation || safeOrg.party_leadership_position || safeOrg.civic_engagement_level || (safeOrg.policy_expertise_areas || []).length > 0;
              
              if (politicalBadges.length === 0 && !hasTextFields) {
                return <p className="text-sm text-slate-500 italic">No political/civic information recorded. Click edit to add.</p>;
              }
              
              return <div className="flex flex-wrap gap-2">{politicalBadges}</div>;
            })()}
            {safeOrg.public_office_held && (
              <div>
                <div className="text-sm font-medium text-slate-700">Office Held</div>
                <div className="text-slate-600">{safeOrg.public_office_held}</div>
              </div>
            )}
            {safeOrg.years_in_office && (
              <div>
                <div className="text-sm font-medium text-slate-700">Years in Office</div>
                <div className="text-slate-600">{safeOrg.years_in_office}</div>
              </div>
            )}
            {safeOrg.political_party_affiliation && (
              <div>
                <div className="text-sm font-medium text-slate-700">Party Affiliation</div>
                <div className="text-slate-600">{String(safeOrg.political_party_affiliation).replace(/_/g, ' ')}</div>
              </div>
            )}
            {safeOrg.party_leadership_position && (
              <div>
                <div className="text-sm font-medium text-slate-700">Party Leadership Position</div>
                <div className="text-slate-600">{safeOrg.party_leadership_position}</div>
              </div>
            )}
            {safeOrg.civic_engagement_level && (
              <div>
                <div className="text-sm font-medium text-slate-700">Civic Engagement Level</div>
                <div className="text-slate-600">{String(safeOrg.civic_engagement_level).replace(/_/g, ' ')}</div>
              </div>
            )}
            {(safeOrg.policy_expertise_areas || []).length > 0 && (
              <div className="pt-3 border-t">
                <div className="text-sm font-medium text-slate-700 mb-2">Policy Expertise Areas</div>
                <div className="flex flex-wrap gap-2">
                  {(safeOrg.policy_expertise_areas || []).map((area, idx) => (
                    <Badge key={idx} variant="outline" className="bg-indigo-50 text-indigo-700">{area}</Badge>
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