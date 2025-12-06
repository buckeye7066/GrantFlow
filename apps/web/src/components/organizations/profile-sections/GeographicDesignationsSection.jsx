import React, { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, MapPin } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

const GEOGRAPHIC_FIELDS = [
  { field: 'rural_resident', label: 'Rural Area Resident', type: 'boolean' },
  { field: 'frontier_county', label: 'Frontier County', type: 'boolean' },
  { field: 'appalachian_region', label: 'Appalachian Region', type: 'boolean' },
  { field: 'urban_underserved', label: 'Urban Underserved', type: 'boolean' },
  { field: 'qct', label: 'Qualified Census Tract', type: 'boolean' },
  { field: 'opportunity_zone', label: 'Opportunity Zone', type: 'boolean' },
  { field: 'ej_area', label: 'Environmental Justice Area', type: 'boolean' },
  { field: 'persistent_poverty_county', label: 'Persistent Poverty County', type: 'boolean' },
  { field: 'tribal_land', label: 'Tribal Land', type: 'boolean' },
  { field: 'fema_disaster_area', label: 'FEMA Disaster Area', type: 'boolean' },
  { field: 'broadband_unserved', label: 'Broadband Unserved', type: 'boolean' },
  { field: 'mua_status', label: 'Medically Underserved Area', type: 'boolean' },
  { field: 'ruca_code', label: 'RUCA Code', type: 'string' },
  { field: 'hpsa_score', label: 'HPSA Score', type: 'number' },
  { field: 'percent_ami', label: '% of Area Median Income', type: 'number' },
];

export default function GeographicDesignationsSection({ 
  organization, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit, 
  onSave, 
  onUpdateField,
  onUpdateTemp, // Accept both names for compatibility
  onUpdate,
  isUpdating,
  scrollToSection
}) {
  const safeOrg = organization || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;
  
  // Use whichever update function is provided - with safety check
  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[GeographicDesignationsSection] No update handler provided for field:', field);
    }
  };
  const sectionRef = useRef(null);

  // Scroll handled by parent - no internal scroll logic needed

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  // Convert string values to proper types before saving
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[GeographicDesignationsSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      // Sanitize data - convert string numbers to actual numbers, handle empty strings
      const sanitizedData = { ...data };
      const numericFields = ['hpsa_score', 'crs_score', 'percent_ami', 'distance_to_services', 'broadband_speed'];
      
      for (const field of numericFields) {
        if (field in sanitizedData) {
          const val = sanitizedData[field];
          if (val === '' || val === null || val === undefined) {
            delete sanitizedData[field]; // Don't send empty values
          } else if (typeof val === 'string') {
            const parsed = parseFloat(val);
            sanitizedData[field] = Number.isFinite(parsed) ? parsed : null;
            if (sanitizedData[field] === null) delete sanitizedData[field];
          }
        }
      }
      
      console.log('[GeographicDesignationsSection] Sanitized data:', sanitizedData);
      onUpdate({ id, data: sanitizedData });
    } else {
      console.error('[GeographicDesignationsSection] ❌ Missing onUpdate, id, or data:', {
        hasOnUpdate: !!onUpdate,
        id,
        data
      });
    }
  };

  return (
    <Card ref={sectionRef} id="geographic-section" className="border-teal-200">
      <CardHeader className="bg-teal-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-teal-900">
          <MapPin className="w-5 h-5 text-teal-600" />
          Geographic & Special Designations
        </CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Geographic Designations"
            fieldsToExtract={GEOGRAPHIC_FIELDS}
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
                { id: 'rural_resident', label: 'Rural Area Resident' },
                { id: 'frontier_county', label: 'Frontier County' },
                { id: 'appalachian_region', label: 'Appalachian Region' },
                { id: 'urban_underserved', label: 'Urban Underserved Area' },
                { id: 'qct', label: 'Qualified Census Tract (QCT)' },
                { id: 'opportunity_zone', label: 'Opportunity Zone' },
                { id: 'ej_area', label: 'EPA Environmental Justice Area' },
                { id: 'persistent_poverty_county', label: 'Persistent-Poverty County' },
                { id: 'tribal_land', label: 'Tribal Reservation/Trust Land' },
                { id: 'us_territory', label: 'U.S. Territory (PR, GU, etc.)' },
                { id: 'fema_disaster_area', label: 'FEMA Disaster Area' },
                { id: 'promise_zone', label: 'Promise Zone' },
                { id: 'choice_neighborhood', label: 'Choice Neighborhood' },
                { id: 'delta_regional_authority', label: 'Delta Regional Authority' },
                { id: 'northern_border_commission', label: 'Northern Border Commission' },
                { id: 'denali_commission', label: 'Denali Commission (Alaska)' },
                { id: 'colonias', label: 'Colonias (Border Community)' },
                { id: 'nmtc_eligible', label: 'NMTC Eligible Tract' },
                { id: 'brownfield_site', label: 'Brownfield Site' },
                { id: 'broadband_unserved', label: 'Broadband-Unserved' },
                { id: 'wui_risk', label: 'Wildland-Urban Interface Fire Risk' },
                { id: 'floodplain', label: 'Floodplain Location' },
                { id: 'mua_status', label: 'Medically Underserved Area' },
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
                <Label className="text-sm font-medium">RUCA Code</Label>
                <Input value={currentData.ruca_code || ''} onChange={(e) => handleFieldUpdate('ruca_code', e.target.value)} placeholder="Rural-Urban Commuting Area" />
              </div>
              <div>
                <Label className="text-sm font-medium">HPSA Score</Label>
                <Input type="number" value={currentData.hpsa_score || ''} onChange={(e) => handleFieldUpdate('hpsa_score', parseFloat(e.target.value) || null)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">CRS Score (Flood)</Label>
                <Input type="number" value={currentData.crs_score || ''} onChange={(e) => handleFieldUpdate('crs_score', parseFloat(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">% of Area Median Income</Label>
                <Input type="number" value={currentData.percent_ami || ''} onChange={(e) => handleFieldUpdate('percent_ami', parseFloat(e.target.value) || null)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">Distance to Services (miles)</Label>
                <Input type="number" value={currentData.distance_to_services || ''} onChange={(e) => handleFieldUpdate('distance_to_services', parseFloat(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">Broadband Speed (Mbps)</Label>
                <Input type="number" value={currentData.broadband_speed || ''} onChange={(e) => handleFieldUpdate('broadband_speed', parseFloat(e.target.value) || null)} />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {safeOrg.rural_resident && <Badge className="bg-teal-100 text-teal-800">Rural</Badge>}
              {safeOrg.frontier_county && <Badge className="bg-teal-100 text-teal-800">Frontier County</Badge>}
              {safeOrg.appalachian_region && <Badge className="bg-teal-100 text-teal-800">Appalachian</Badge>}
              {safeOrg.urban_underserved && <Badge className="bg-teal-100 text-teal-800">Urban Underserved</Badge>}
              {safeOrg.qct && <Badge className="bg-teal-100 text-teal-800">QCT</Badge>}
              {safeOrg.opportunity_zone && <Badge className="bg-teal-100 text-teal-800">Opportunity Zone</Badge>}
              {safeOrg.ej_area && <Badge className="bg-teal-100 text-teal-800">EJ Area</Badge>}
              {safeOrg.persistent_poverty_county && <Badge className="bg-teal-100 text-teal-800">Persistent Poverty</Badge>}
              {safeOrg.tribal_land && <Badge className="bg-teal-100 text-teal-800">Tribal Land</Badge>}
              {safeOrg.us_territory && <Badge className="bg-teal-100 text-teal-800">U.S. Territory</Badge>}
              {safeOrg.fema_disaster_area && <Badge className="bg-teal-100 text-teal-800">FEMA Disaster Area</Badge>}
              {safeOrg.promise_zone && <Badge className="bg-teal-100 text-teal-800">Promise Zone</Badge>}
              {safeOrg.choice_neighborhood && <Badge className="bg-teal-100 text-teal-800">Choice Neighborhood</Badge>}
              {safeOrg.delta_regional_authority && <Badge className="bg-teal-100 text-teal-800">Delta Regional Authority</Badge>}
              {safeOrg.northern_border_commission && <Badge className="bg-teal-100 text-teal-800">Northern Border Commission</Badge>}
              {safeOrg.denali_commission && <Badge className="bg-teal-100 text-teal-800">Denali Commission</Badge>}
              {safeOrg.colonias && <Badge className="bg-teal-100 text-teal-800">Colonias</Badge>}
              {safeOrg.nmtc_eligible && <Badge className="bg-teal-100 text-teal-800">NMTC Eligible</Badge>}
              {safeOrg.brownfield_site && <Badge className="bg-teal-100 text-teal-800">Brownfield Site</Badge>}
              {safeOrg.broadband_unserved && <Badge className="bg-teal-100 text-teal-800">Broadband Unserved</Badge>}
              {safeOrg.wui_risk && <Badge className="bg-teal-100 text-teal-800">WUI Fire Risk</Badge>}
              {safeOrg.floodplain && <Badge className="bg-teal-100 text-teal-800">Floodplain</Badge>}
              {safeOrg.mua_status && <Badge className="bg-teal-100 text-teal-800">MUA</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {safeOrg.ruca_code && <div><div className="text-sm font-medium text-slate-700">RUCA Code</div><div className="text-slate-600">{safeOrg.ruca_code}</div></div>}
              {safeOrg.hpsa_score && <div><div className="text-sm font-medium text-slate-700">HPSA Score</div><div className="text-slate-600">{safeOrg.hpsa_score}</div></div>}
              {safeOrg.percent_ami && <div><div className="text-sm font-medium text-slate-700">% AMI</div><div className="text-slate-600">{safeOrg.percent_ami}%</div></div>}
              {safeOrg.crs_score && <div><div className="text-sm font-medium text-slate-700">CRS Score</div><div className="text-slate-600">{safeOrg.crs_score}</div></div>}
              {safeOrg.distance_to_services && <div><div className="text-sm font-medium text-slate-700">Distance to Services</div><div className="text-slate-600">{safeOrg.distance_to_services} mi</div></div>}
              {safeOrg.broadband_speed && <div><div className="text-sm font-medium text-slate-700">Broadband Speed</div><div className="text-slate-600">{safeOrg.broadband_speed} Mbps</div></div>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}