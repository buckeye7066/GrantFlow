import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { 
  User, 
  GraduationCap, 
  Building2, 
  Heart, 
  Stethoscope, 
  Users, 
  BookOpen,
  Save,
  Loader2,
  Pencil,
  X
} from 'lucide-react';

const APPLICANT_TYPES = [
  { value: 'organization', label: 'Organization/Nonprofit', icon: Building2, description: 'Nonprofit, business, or other organization' },
  { value: 'high_school_student', label: 'High School Student', icon: GraduationCap, description: 'Currently in high school' },
  { value: 'college_student', label: 'College Student', icon: GraduationCap, description: 'Currently in undergraduate program' },
  { value: 'graduate_student', label: 'Graduate Student', icon: BookOpen, description: 'Masters, PhD, or professional program' },
  { value: 'individual_need', label: 'Individual Need', icon: User, description: 'Personal assistance or support' },
  { value: 'medical_assistance', label: 'Medical Assistance', icon: Stethoscope, description: 'Healthcare or medical funding' },
  { value: 'family', label: 'Family', icon: Users, description: 'Family-based assistance' },
  { value: 'homeschool_family', label: 'Homeschool Family', icon: BookOpen, description: 'Homeschooling support' },
  { value: 'other', label: 'Other', icon: Heart, description: 'Other type of applicant' },
];

/**
 * ProfileTypeEditor - Allows users to change their profile/applicant type
 */
export default function ProfileTypeEditor({ 
  organization, 
  onUpdate, 
  isUpdating = false 
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [selectedType, setSelectedType] = useState(organization?.applicant_type || 'individual_need');
  
  const currentType = APPLICANT_TYPES.find(t => t.value === organization?.applicant_type);
  const CurrentIcon = currentType?.icon || User;
  
  const handleSave = () => {
    if (selectedType !== organization?.applicant_type) {
      onUpdate({
        id: organization.id,
        data: { applicant_type: selectedType }
      });
    }
    setIsEditing(false);
  };
  
  const handleCancel = () => {
    setSelectedType(organization?.applicant_type || 'individual_need');
    setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <CurrentIcon className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-lg">Profile Type</CardTitle>
                <CardDescription>
                  {currentType?.label || 'Not set'} — {currentType?.description || 'Select your profile type'}
                </CardDescription>
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setIsEditing(true)}
              disabled={isUpdating}
            >
              <Pencil className="w-4 h-4 mr-2" />
              Change Type
            </Button>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="mb-6 border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Change Profile Type</CardTitle>
            <CardDescription>
              Select the type that best describes this profile. This affects which sections and matching criteria are used.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleCancel}
              disabled={isUpdating}
            >
              <X className="w-4 h-4 mr-1" />
              Cancel
            </Button>
            <Button 
              size="sm" 
              onClick={handleSave}
              disabled={isUpdating || selectedType === organization?.applicant_type}
            >
              {isUpdating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {APPLICANT_TYPES.map((type) => {
            const Icon = type.icon;
            const isSelected = selectedType === type.value;
            
            return (
              <div
                key={type.value}
                onClick={() => setSelectedType(type.value)}
                className={`
                  relative flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all
                  ${isSelected 
                    ? 'border-blue-500 bg-blue-50 shadow-sm' 
                    : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50'
                  }
                `}
              >
                <div className={`p-2 rounded-lg ${isSelected ? 'bg-blue-100' : 'bg-slate-100'}`}>
                  <Icon className={`w-5 h-5 ${isSelected ? 'text-blue-600' : 'text-slate-500'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${isSelected ? 'text-blue-900' : 'text-slate-700'}`}>
                      {type.label}
                    </span>
                    {organization?.applicant_type === type.value && (
                      <Badge variant="secondary" className="text-xs">Current</Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-500 mt-0.5">{type.description}</p>
                </div>
                {isSelected && (
                  <div className="absolute top-2 right-2">
                    <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}