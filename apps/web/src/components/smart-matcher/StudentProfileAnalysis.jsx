import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  GraduationCap, 
  Trophy, 
  BookOpen, 
  Target,
  CheckCircle2,
  XCircle,
  AlertTriangle
} from 'lucide-react';

/**
 * Displays a student's profile analysis for grant matching
 */
export default function StudentProfileAnalysis({ organization }) {
  if (!organization) return null;

  const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(organization.applicant_type);
  
  // Calculate profile completeness for matching
  const getProfileStrength = () => {
    const fields = [
      { key: 'gpa', weight: 15 },
      { key: 'test_scores', weight: 15, check: (v) => v && (v.sat || v.act) },
      { key: 'intended_major', weight: 10 },
      { key: 'extracurricular_activities', weight: 15, check: (v) => v && v.length > 0 },
      { key: 'community_service_hours', weight: 10 },
      { key: 'state', weight: 5 },
      { key: 'household_income', weight: 10 },
      { key: 'race_ethnicity', weight: 5, check: (v) => v && v.length > 0 },
      { key: 'focus_areas', weight: 10, check: (v) => v && v.length > 0 },
      { key: 'goals', weight: 5 },
    ];

    let score = 0;
    const missing = [];
    const present = [];

    fields.forEach(field => {
      const value = organization[field.key];
      const hasValue = field.check ? field.check(value) : !!value;
      
      if (hasValue) {
        score += field.weight;
        present.push(field.key);
      } else {
        missing.push(field.key);
      }
    });

    return { score, missing, present };
  };

  const profileStrength = getProfileStrength();

  const formatFieldName = (key) => {
    return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <GraduationCap className="w-5 h-5 text-blue-600" />
          Profile Match Readiness
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Profile Strength Meter */}
        <div>
          <div className="flex justify-between text-sm mb-2">
            <span className="font-medium text-slate-700">Profile Completeness</span>
            <span className="font-bold text-blue-600">{profileStrength.score}%</span>
          </div>
          <Progress value={profileStrength.score} className="h-3" />
          <p className="text-xs text-slate-500 mt-1">
            {profileStrength.score >= 80 ? '✨ Excellent! Your profile is ready for optimal matching.' :
             profileStrength.score >= 60 ? '👍 Good profile. Add more details for better matches.' :
             '⚠️ Add more profile details to improve match quality.'}
          </p>
        </div>

        {/* Key Stats */}
        <div className="grid grid-cols-2 gap-3">
          {organization.gpa && (
            <div className="bg-white p-3 rounded-lg border">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-green-600" />
                <span className="text-xs text-slate-500">GPA</span>
              </div>
              <p className="text-lg font-bold text-slate-900">{organization.gpa}</p>
            </div>
          )}
          
          {organization.test_scores?.sat && (
            <div className="bg-white p-3 rounded-lg border">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-purple-600" />
                <span className="text-xs text-slate-500">SAT</span>
              </div>
              <p className="text-lg font-bold text-slate-900">{organization.test_scores.sat}</p>
            </div>
          )}
          
          {organization.test_scores?.act && (
            <div className="bg-white p-3 rounded-lg border">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-orange-600" />
                <span className="text-xs text-slate-500">ACT</span>
              </div>
              <p className="text-lg font-bold text-slate-900">{organization.test_scores.act}</p>
            </div>
          )}
          
          {organization.community_service_hours > 0 && (
            <div className="bg-white p-3 rounded-lg border">
              <div className="flex items-center gap-2">
                <Trophy className="w-4 h-4 text-amber-600" />
                <span className="text-xs text-slate-500">Service Hours</span>
              </div>
              <p className="text-lg font-bold text-slate-900">{organization.community_service_hours}</p>
            </div>
          )}
        </div>

        {/* Activities */}
        {organization.extracurricular_activities?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Activities for Matching</p>
            <div className="flex flex-wrap gap-1">
              {organization.extracurricular_activities.slice(0, 5).map((activity, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {activity}
                </Badge>
              ))}
              {organization.extracurricular_activities.length > 5 && (
                <Badge variant="outline" className="text-xs">
                  +{organization.extracurricular_activities.length - 5} more
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Missing Fields for Better Matching */}
        {profileStrength.missing.length > 0 && profileStrength.score < 80 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-amber-800 mb-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Add these for better matches:
            </p>
            <div className="flex flex-wrap gap-1">
              {profileStrength.missing.slice(0, 4).map((field, i) => (
                <Badge key={i} variant="outline" className="text-xs bg-white text-amber-700 border-amber-300">
                  {formatFieldName(field)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}