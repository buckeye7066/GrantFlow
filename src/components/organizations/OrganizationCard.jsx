
import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, MapPin, Edit, TrendingUp, GraduationCap, Heart, User, Award, Zap, Trash2, Receipt } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import client from '@/api/client';

export default function OrganizationCard({ organization, grantCount, isSelected, onClick, onEdit, onAutomatedSearch, onDelete, onInvoice }) {
  const [imgError, setImgError] = React.useState(false);

  React.useEffect(() => {
    // Reset imgError when the profile_image_url changes
    setImgError(false);
  }, [organization.profile_image_url]);

  const ORGANIZATION_TYPES = ['organization', 'nonprofit', 'business', 'government'];
  const isOrganization = ORGANIZATION_TYPES.includes(organization.applicant_type);
  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type);
  const isIndividual = [
    'individual_need',
    'medical_assistance',
    'family',
    'veteran',
    'caregiver',
    'disabled_person',
    'emergency_affected'
  ].includes(organization.applicant_type);
  // Only nudge when the profile genuinely has NO type. The visible type badge
  // renders whenever `applicant_type` is truthy (even for values outside the
  // canonical org/student/individual buckets, e.g. "student" or "family"), so
  // keying the nudge off the same field prevents nagging already-typed entries.
  const isUnknownType = !organization.applicant_type;

  const { data: taxonomyItems = [] } = useQuery({
      queryKey: ['taxonomy', organization.applicant_type],
      queryFn: () => client.entities.Taxonomy.list(),
      enabled: isIndividual && !!organization.assistance_categories,
  });

  // NOTE: We are NOT fetching ContactMethods here to keep the card list performant.
  // The card will rely on the deprecated legacy fields for now.
  // The main profile view will show the correct, up-to-date data.

  const assistanceCategoryLabels = React.useMemo(() => {
    if (!isIndividual || !organization.assistance_categories) return [];
    return organization.assistance_categories.map(slug => {
        const item = taxonomyItems.find(t => t.group === 'individual_assistance' && t.slug === slug);
        return item ? item.label : slug;
    }).slice(0, 2);
  }, [taxonomyItems, organization.assistance_categories, isIndividual]);
  
  // Format grade levels for display
  const gradeLevelLabels = React.useMemo(() => {
    if (!isStudent) return [];
    
    const levels = organization.student_grade_levels || 
                   (organization.student_grade_level ? [organization.student_grade_level] : []);
    
    return levels.map(level => 
      level.replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    );
  }, [organization.student_grade_levels, organization.student_grade_level, isStudent]);

  const getIcon = () => {
    if (isStudent) return GraduationCap;
    if (isIndividual) return Heart;
    return Building2;
  };

  const getColor = () => {
    if (isStudent) return 'indigo';
    if (isIndividual) return 'rose';
    return 'blue';
  };

  const Icon = getIcon();
  const color = getColor();

  return (
    <Card 
      className={`hover:shadow-xl transition-all duration-300 border-2 overflow-hidden group cursor-pointer ${isSelected ? `border-${color}-500 shadow-xl` : 'border-transparent'}`}
      onClick={onClick}
    >
      <div className={`h-1.5 bg-gradient-to-r from-${color}-500 to-${color}-600`} />
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-4 flex-1">
            {organization.profile_image_url && !imgError ? (
                <img 
                  src={organization.profile_image_url} 
                  alt={organization.name} 
                  className="w-12 h-12 rounded-lg object-cover border border-slate-100"
                  onError={() => setImgError(true)} // Set imgError to true on error
                />
            ) : (
                <div className={`p-2.5 bg-${color}-50 rounded-lg group-hover:bg-${color}-100 transition-colors`}>
                    <Icon className={`w-5 h-5 text-${color}-600`} />
                </div>
            )}
            <div className="flex-1">
              <h3 className="font-bold text-slate-900 text-base leading-tight">{organization.name}</h3>
              {organization.applicant_type && (
                <Badge variant="outline" className="mt-1.5 text-xs">
                  {organization.applicant_type.replace(/_/g, ' ')}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex gap-0.5">
            {onInvoice && (
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); onInvoice(organization); }}
                className="h-8 w-8 hover:bg-green-100"
                title="Create Invoice"
              >
                <Receipt className="w-4 h-4 text-green-600" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); onEdit(organization); }}
              className="h-8 w-8 hover:bg-slate-100"
              title="Edit Profile"
            >
              <Edit className="w-4 h-4" />
            </Button>
            {onAutomatedSearch && ( 
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); onAutomatedSearch(organization); }}
                className="h-8 w-8 hover:bg-blue-100"
                title="Configure Automated Search"
              >
                <Zap className="w-4 h-4 text-blue-600" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); onDelete(organization); }}
              className="h-8 w-8 hover:bg-red-100"
              title="Delete Profile"
            >
              <Trash2 className="w-4 h-4 text-red-600" />
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {/* Organization Info */}
          {isOrganization && organization.mission && (
            <p className="text-slate-600 text-sm line-clamp-2">
              {organization.mission}
            </p>
          )}

          {/* Student Info */}
          {isStudent && (
            <div className="space-y-1.5">
              {organization.gpa && parseFloat(organization.gpa) > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <Award className="w-3 h-3 text-indigo-600" />
                  <span className="font-semibold text-slate-700">GPA: {parseFloat(organization.gpa).toFixed(2)}</span>
                </div>
              )}
              {organization.intended_major && (
                <p className="text-xs text-slate-600 truncate">
                  <strong>Major:</strong> {organization.intended_major}
                </p>
              )}
              {gradeLevelLabels.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {gradeLevelLabels.slice(0, 2).map((label, index) => (
                    <Badge key={index} variant="secondary" className="text-xs">
                      {label}
                    </Badge>
                  ))}
                  {gradeLevelLabels.length > 2 && (
                    <Badge variant="secondary" className="text-xs">
                      +{gradeLevelLabels.length - 2} more
                    </Badge>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Individual Info */}
          {isIndividual && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {assistanceCategoryLabels.map((label, index) => (
                     <Badge key={index} variant="outline" className="bg-rose-50 text-rose-700 text-xs">
                        {label}
                    </Badge>
                ))}
                {(organization.assistance_categories?.length || 0) > 2 && (
                     <Badge variant="outline" className="bg-rose-50 text-rose-700 text-xs">
                        +{(organization.assistance_categories?.length || 0) - 2} more
                    </Badge>
                )}
              </div>
              {organization.financial_need_level && (
                <p className="text-xs text-slate-600">
                  <strong>Need Level:</strong> {organization.financial_need_level}
                </p>
              )}
            </div>
          )}

          {/* Location */}
          {organization.city && organization.state && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <MapPin className="w-3 h-3" />
              <span className="truncate">{organization.city}, {organization.state}</span>
            </div>
          )}

          {/* Tags */}
          {isOrganization && organization.program_areas && organization.program_areas.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {organization.program_areas.slice(0, 3).map((area, index) => (
                <Badge key={index} variant="secondary" className="text-xs">
                  {area}
                </Badge>
              ))}
              {organization.program_areas.length > 3 && (
                <Badge variant="secondary" className="text-xs">
                  +{organization.program_areas.length - 3} more
                </Badge>
              )}
            </div>
          )}

          {isStudent && organization.extracurricular_activities && organization.extracurricular_activities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {organization.extracurricular_activities.slice(0, 2).map((activity, index) => (
                <Badge key={index} variant="secondary" className="text-xs">
                  {activity}
                </Badge>
              ))}
              {organization.extracurricular_activities.length > 2 && (
                <Badge variant="secondary" className="text-xs">
                  +{organization.extracurricular_activities.length - 2} more
                </Badge>
              )}
            </div>
          )}
        </div>


        {/* Profile completeness nudge for unknown type */}
        {isUnknownType && (
          <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded px-2 py-1 mb-2">
            <User className="w-3 h-3" />
            <span>Complete your profile type to improve grant matching.</span>
          </div>
        )}
        {/* Grant Count */}
        <div className="flex items-center gap-2 pt-4 mt-4 border-t border-slate-100">
          <TrendingUp className="w-4 h-4 text-emerald-600" />
          <span className="text-sm font-medium text-slate-900">
            {grantCount} {isStudent ? 'Scholarships' : isIndividual ? 'Programs' : 'Grants'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
