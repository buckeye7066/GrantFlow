import React, { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Edit, X, Save, FileText } from 'lucide-react';

const NARRATIVE_FIELDS = [
  { field: 'mission', label: 'Mission / Bio', placeholder: 'Describe your mission, purpose, or personal story...' },
  { field: 'primary_goal', label: 'Primary Goals', placeholder: 'What are your main goals and objectives?' },
  { field: 'target_population', label: 'Target Population / Background', placeholder: 'Who do you serve or what is your background?' },
  { field: 'geographic_focus', label: 'Geographic Focus', placeholder: 'What geographic areas do you focus on?' },
  { field: 'funding_amount_needed', label: 'Funding Needs', placeholder: 'How much funding do you need and for what?' },
  { field: 'timeline', label: 'Timeline', placeholder: 'What is your timeline for activities or projects?' },
  { field: 'past_experience', label: 'Past Experience / Track Record', placeholder: 'Describe your relevant experience and achievements...' },
  { field: 'unique_qualities', label: 'Unique Qualities', placeholder: 'What makes you or your organization unique?' },
  { field: 'collaboration_partners', label: 'Collaboration Partners', placeholder: 'List any partners or collaborators...' },
  { field: 'sustainability_plan', label: 'Sustainability Plan', placeholder: 'How will you sustain this work long-term?' },
  { field: 'barriers_faced', label: 'Barriers & Challenges', placeholder: 'What barriers or challenges do you face?' },
  { field: 'special_circumstances', label: 'Special Circumstances', placeholder: 'Any special circumstances to note...' },
];

export default function NarrativeSection({ 
  org, 
  isEditing,
  tempData,
  onStartEdit,
  onCancel,
  onSave,
  onUpdateTemp,
  isUpdating,
  scrollToSection
}) {
  const safeOrg = org || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;
  const sectionRef = useRef(null);

  // Scroll handled by parent - no internal scroll logic needed

  return (
    <Card ref={sectionRef} id="narrative-section" className="border-indigo-200">
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-indigo-900">
          <FileText className="w-5 h-5 text-indigo-600" />
          Narrative & Goals
        </CardTitle>
        <div className="flex gap-2">
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={isUpdating}>
                <X className="w-4 h-4" />
              </Button>
              <Button variant="default" size="sm" onClick={onSave} disabled={isUpdating}>
                <Save className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {isEditing ? (
          <div className="space-y-4">
            {NARRATIVE_FIELDS.map(({ field, label, placeholder }) => (
              <div key={field}>
                <Label className="text-sm font-medium">{label}</Label>
                <Textarea
                  value={currentData[field] || ''}
                  onChange={(e) => onUpdateTemp(field, e.target.value)}
                  placeholder={placeholder}
                  rows={3}
                  className="mt-1"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {NARRATIVE_FIELDS.map(({ field, label }) => {
              const value = safeOrg[field];
              if (!value) return null;
              return (
                <div key={field}>
                  <div className="text-sm font-medium text-slate-700">{label}</div>
                  <p className="text-slate-600 whitespace-pre-wrap">{value}</p>
                </div>
              );
            })}
            {!NARRATIVE_FIELDS.some(f => safeOrg[f.field]) && (
              <p className="text-slate-500 italic">No narrative information added yet. Click Edit to add details.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}