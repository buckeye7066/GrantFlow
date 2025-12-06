import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Building2, GraduationCap, Heart } from 'lucide-react';

/**
 * Reusable profile type selector
 * Visual card-based selection for applicant type
 */
export default function ProfileTypeSelector({ value, onChange }) {
  const types = [
    {
      value: 'organization',
      icon: Building2,
      label: 'Organization',
      description: 'Nonprofits, businesses, schools',
      color: 'blue',
    },
    {
      value: 'high_school_student',
      icon: GraduationCap,
      label: 'Student',
      description: 'High school, college, graduate',
      color: 'indigo',
    },
    {
      value: 'individual_need',
      icon: Heart,
      label: 'Individual',
      description: 'Medical, emergency assistance',
      color: 'rose',
    },
  ];

  const isStudentType = ['high_school_student', 'college_student', 'graduate_student'].includes(value);
  const isIndividualType = ['individual_need', 'medical_assistance', 'family'].includes(value);

  return (
    <Card className="bg-slate-50 border-slate-200">
      <CardContent className="p-4">
        <Label className="text-base font-semibold mb-3 block">
          Profile Type *
        </Label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Profile type">
          {types.map(type => {
            const isSelected = 
              (type.value === 'organization' && value === 'organization') ||
              (type.value === 'high_school_student' && isStudentType) ||
              (type.value === 'individual_need' && isIndividualType);

            return (
              <button
                key={type.value}
                type="button"
                onClick={() => onChange(type.value)}
                className={`p-4 rounded-lg border-2 transition-all ${
                  isSelected
                    ? `border-${type.color}-600 bg-${type.color}-50`
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
              >
                <type.icon
                  className={`w-6 h-6 mx-auto mb-2 ${
                    isSelected ? `text-${type.color}-600` : 'text-slate-400'
                  }`}
                />
                <p className="font-semibold text-sm">{type.label}</p>
                <p className="text-xs text-slate-600 mt-1">{type.description}</p>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}