import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { GraduationCap, Edit, X, Save, Plus } from 'lucide-react';

export default function EducationHistorySection({
  organization,
  editingSection,
  currentData,
  isUpdating,
  onStartEdit,
  onCancelEdit,
  onSaveSection,
  onUpdateTempField
}) {
  const safeOrg = organization || {};
  const safeCurrentData = currentData || {};
  
  const educationHistory = editingSection === 'education_history' 
    ? (safeCurrentData.education_history || [])
    : (safeOrg.education_history || []);

  return (
    <Card>
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-indigo-900">
          <GraduationCap className="w-5 h-5" />
          Schools Attended (for Transcripts)
        </CardTitle>
        {editingSection !== 'education_history' ? (
          <Button variant="ghost" size="sm" onClick={() => onStartEdit('education_history')} disabled={isUpdating}>
            <Edit className="w-4 h-4" />
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
              <X className="w-4 h-4" />
            </Button>
            <Button variant="default" size="sm" onClick={onSaveSection} disabled={isUpdating}>
              <Save className="w-4 h-4" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {editingSection === 'education_history' ? (
          <div className="space-y-3">
            {educationHistory.map((school, idx) => (
              <div key={idx} className="p-3 bg-slate-50 rounded border space-y-2">
                <div className="flex justify-between items-start">
                  <span className="text-sm font-medium">School #{idx + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const updated = [...educationHistory];
                      updated.splice(idx, 1);
                      onUpdateTempField('education_history', updated);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
                <Input
                  placeholder="Institution Name"
                  value={(school || {}).institution_name || ''}
                  onChange={(e) => {
                    const updated = [...educationHistory];
                    updated[idx] = { ...(updated[idx] || {}), institution_name: e.target.value };
                    onUpdateTempField('education_history', updated);
                  }}
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="w-full p-2 border rounded text-sm"
                    value={(school || {}).institution_type || 'high_school'}
                    onChange={(e) => {
                      const updated = [...educationHistory];
                      updated[idx] = { ...(updated[idx] || {}), institution_type: e.target.value };
                      onUpdateTempField('education_history', updated);
                    }}
                  >
                    <option value="high_school">High School</option>
                    <option value="community_college">Community College</option>
                    <option value="university">University</option>
                    <option value="graduate_school">Graduate School</option>
                    <option value="other">Other</option>
                  </select>
                  <Input
                    placeholder="Years (e.g., 2020-2024)"
                    value={(school || {}).years_attended || ''}
                    onChange={(e) => {
                      const updated = [...educationHistory];
                      updated[idx] = { ...(updated[idx] || {}), years_attended: e.target.value };
                      onUpdateTempField('education_history', updated);
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={!!(school || {}).graduated}
                    onCheckedChange={(checked) => {
                      const updated = [...educationHistory];
                      updated[idx] = { ...(updated[idx] || {}), graduated: checked };
                      onUpdateTempField('education_history', updated);
                    }}
                  />
                  <Label className="text-sm">Graduated</Label>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const updated = [...educationHistory, { institution_name: '', institution_type: 'high_school', years_attended: '', graduated: false }];
                onUpdateTempField('education_history', updated);
              }}
            >
              <Plus className="w-4 h-4 mr-1" /> Add School
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {educationHistory.length > 0 ? (
              educationHistory.map((school, idx) => {
                const safeSchool = school || {};
                return (
                  <div key={idx} className="p-2 bg-slate-50 rounded border text-sm">
                    <div className="font-medium">{safeSchool.institution_name || 'Unknown School'}</div>
                    <div className="text-slate-600 text-xs">
                      {(safeSchool.institution_type || 'unknown')?.replace(/_/g, ' ')} • {safeSchool.years_attended || 'N/A'}
                      {safeSchool.graduated && ' • Graduated'}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-slate-500 italic">No schools added yet. Click edit to add schools attended.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}