import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Edit, X, Save, RefreshCw } from 'lucide-react';
import EditableTagList from '@/components/shared/EditableTagList';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';

const EDUCATION_FIELDS = [
  { field: 'current_college', label: 'Current College/University', type: 'string' },
  { field: 'intended_major', label: 'Intended Major', type: 'string' },
  { field: 'gpa', label: 'GPA', type: 'number' },
  { field: 'community_service_hours', label: 'Community Service Hours', type: 'number' },
  { field: 'act_score', label: 'ACT Score', type: 'number' },
  { field: 'sat_score', label: 'SAT Score', type: 'number' },
  { field: 'gre_score', label: 'GRE Score', type: 'number' },
  { field: 'gmat_score', label: 'GMAT Score', type: 'number' },
  { field: 'lsat_score', label: 'LSAT Score', type: 'number' },
  { field: 'mcat_score', label: 'MCAT Score', type: 'number' },
  { field: 'cte_pathway', label: 'CTE Pathway', type: 'string' },
  { field: 'idea_disability_category', label: 'IDEA Disability Category', type: 'string' },
  { field: 'efc_sai_band', label: 'EFC/SAI Band', type: 'string' },
  { field: 'first_generation', label: 'First-Generation College Student', type: 'boolean' },
  { field: 'stem_student', label: 'STEM Student', type: 'boolean' },
  { field: 'arts_humanities_field', label: 'Arts/Humanities Field', type: 'boolean' },
  { field: 'medical_nursing_field', label: 'Medical/Nursing/Allied Health', type: 'boolean' },
  { field: 'education_social_work_field', label: 'Education/Social Work Field', type: 'boolean' },
  { field: 'trade_apprenticeship_participant', label: 'Trade/Apprenticeship', type: 'boolean' },
  { field: 'ged_graduate', label: 'GED Graduate', type: 'boolean' },
  { field: 'returning_adult_student', label: 'Returning Adult Student', type: 'boolean' },
  { field: 'recent_graduate', label: 'Recent Graduate', type: 'boolean' },
  { field: 'pell_eligible', label: 'Pell Grant Eligible', type: 'boolean' },
  { field: 'fafsa_completed', label: 'FAFSA Completed', type: 'boolean' },
  { field: 'student_with_dependents', label: 'Student with Dependents', type: 'boolean' },
  { field: 'homeschool_family', label: 'Homeschool Student', type: 'boolean' },
  { field: 'private_school_student', label: 'Private School', type: 'boolean' },
  { field: 'charter_school_student', label: 'Charter/Micro-School', type: 'boolean' },
  { field: 'title_i_school', label: 'Attends Title I School', type: 'boolean' },
  { field: 'iep_504', label: 'IEP/504 Status', type: 'boolean' },
  { field: 'dual_enrollment', label: 'Dual Enrollment / Early College', type: 'boolean' },
  { field: 'rotc_jrotc', label: 'ROTC / JROTC', type: 'boolean' },
];

export default function EducationSection({ 
  organization,
  org, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit,
  onCancel, 
  onSave, 
  onUpdateField,
  onUpdateTemp,
  onUpdate,
  isUpdating 
}) {
  const safeOrg = organization || org || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;
  const [isPulling, setIsPulling] = useState(false);
  const handleCancel = onCancelEdit || onCancel;

  // Use whichever update function is provided - with safety check
  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[EducationSection] No update handler provided for field:', field);
    }
  };

  // Fetch university applications for this profile
  const { data: applications = [] } = useQuery({
    queryKey: ['universityApplications', safeOrg.id],
    queryFn: () => base44.entities.UniversityApplication.filter({ organization_id: safeOrg.id }),
    enabled: !!safeOrg.id,
  });

  // Pull target colleges from university applications
  const handlePullFromApplications = async () => {
    if (!applications.length || !safeOrg.id || !onUpdate) return;
    
    setIsPulling(true);
    try {
      // Get existing target colleges
      const existingColleges = safeOrg.target_colleges || [];
      
      // Get unique university names from applications
      const applicationColleges = applications
        .map(app => app.university_name)
        .filter(name => name && name.trim());
      
      // Merge without duplicates (case-insensitive)
      const existingLower = existingColleges.map(c => c.toLowerCase());
      const newColleges = applicationColleges.filter(
        name => !existingLower.includes(name.toLowerCase())
      );
      
      if (newColleges.length > 0) {
        const merged = [...existingColleges, ...newColleges];
        await onUpdate({ id: safeOrg.id, data: { target_colleges: merged } });
      }
    } catch (err) {
      console.error('[EducationSection] Error pulling colleges:', err);
    } finally {
      setIsPulling(false);
    }
  };

  return (
    <Card className="border-indigo-200">
      <CardHeader className="bg-indigo-50 flex flex-row items-center justify-between">
        <CardTitle className="text-indigo-900">Education Details</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Education"
            fieldsToExtract={EDUCATION_FIELDS}
            onUpdate={onUpdate}
            disabled={isUpdating || isEditing}
          />
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isUpdating}>
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
            <div>
              <Label className="text-sm font-medium">Current College/University</Label>
              <Input
                value={currentData.current_college || ''}
                onChange={(e) => handleFieldUpdate('current_college', e.target.value)}
                placeholder="e.g., University of Tennessee"
              />
            </div>
            <div>
              <Label className="text-sm font-medium">Intended Major</Label>
              <Input
                value={currentData.intended_major || ''}
                onChange={(e) => handleFieldUpdate('intended_major', e.target.value)}
                placeholder="e.g., Computer Science"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">GPA</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={currentData.gpa || ''}
                  onChange={(e) => handleFieldUpdate('gpa', parseFloat(e.target.value) || null)}
                  placeholder="3.75"
                />
              </div>
              <div>
                <Label className="text-sm font-medium">Community Service Hours</Label>
                <Input
                  type="number"
                  value={currentData.community_service_hours || ''}
                  onChange={(e) => handleFieldUpdate('community_service_hours', parseInt(e.target.value) || null)}
                  placeholder="200"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">ACT Score</Label>
                <Input
                  type="number"
                  value={currentData.act_score || ''}
                  onChange={(e) => handleFieldUpdate('act_score', parseInt(e.target.value) || null)}
                />
              </div>
              <div>
                <Label className="text-sm font-medium">SAT Score</Label>
                <Input
                  type="number"
                  value={currentData.sat_score || ''}
                  onChange={(e) => handleFieldUpdate('sat_score', parseInt(e.target.value) || null)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">GRE Score</Label>
                <Input type="number" value={currentData.gre_score || ''} onChange={(e) => handleFieldUpdate('gre_score', parseInt(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">GMAT Score</Label>
                <Input type="number" value={currentData.gmat_score || ''} onChange={(e) => handleFieldUpdate('gmat_score', parseInt(e.target.value) || null)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-medium">LSAT Score</Label>
                <Input type="number" value={currentData.lsat_score || ''} onChange={(e) => handleFieldUpdate('lsat_score', parseInt(e.target.value) || null)} />
              </div>
              <div>
                <Label className="text-sm font-medium">MCAT Score</Label>
                <Input type="number" value={currentData.mcat_score || ''} onChange={(e) => handleFieldUpdate('mcat_score', parseInt(e.target.value) || null)} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">CTE Pathway</Label>
              <Input value={currentData.cte_pathway || ''} onChange={(e) => handleFieldUpdate('cte_pathway', e.target.value)} placeholder="e.g., EMT, Welding, Cybersecurity" />
            </div>
            <div>
              <Label className="text-sm font-medium">IDEA Disability Category</Label>
              <Input value={currentData.idea_disability_category || ''} onChange={(e) => handleFieldUpdate('idea_disability_category', e.target.value)} placeholder="e.g., Autism, Specific Learning Disability" />
            </div>
            <div>
              <Label className="text-sm font-medium">EFC/SAI Band</Label>
              <Input value={currentData.efc_sai_band || ''} onChange={(e) => handleFieldUpdate('efc_sai_band', e.target.value)} placeholder="e.g., 0-3000" />
            </div>
            <div>
              <Label className="text-sm font-medium">Student Housing Status</Label>
              <select className="w-full p-2 border rounded" value={currentData.student_housing_status || ''} onChange={(e) => handleFieldUpdate('student_housing_status', e.target.value)}>
                <option value="">Select...</option>
                <option value="on_campus">On-Campus</option>
                <option value="off_campus">Off-Campus</option>
                <option value="commuter">Commuter</option>
                <option value="independent">Independent</option>
              </select>
            </div>
            <h4 className="font-semibold text-sm pt-3 border-t">Academic Characteristics</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'first_generation', label: 'First-Generation College Student' },
                { id: 'stem_student', label: 'STEM Student' },
                { id: 'arts_humanities_field', label: 'Arts/Humanities Field' },
                { id: 'medical_nursing_field', label: 'Medical/Nursing/Allied Health' },
                { id: 'education_social_work_field', label: 'Education/Social Work Field' },
                { id: 'trade_apprenticeship_participant', label: 'Trade/Apprenticeship' },
                { id: 'ged_graduate', label: 'GED Graduate' },
                { id: 'returning_adult_student', label: 'Returning Adult Student' },
                { id: 'recent_graduate', label: 'Recent Graduate' },
                { id: 'pell_eligible', label: 'Pell Grant Eligible' },
                { id: 'fafsa_completed', label: 'FAFSA Completed' },
                { id: 'student_with_dependents', label: 'Student with Dependents' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <h4 className="font-semibold text-sm pt-3 border-t">Education Type & Setting</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'homeschool_family', label: 'Homeschool Student' },
                { id: 'private_school_student', label: 'Private School' },
                { id: 'charter_school_student', label: 'Charter/Micro-School' },
                { id: 'virtual_academy_student', label: 'Virtual Academy' },
                { id: 'parent_led_education', label: 'Parent-Led Education' },
                { id: 'homeschool_coop_member', label: 'Homeschool Co-op Member' },
                { id: 'esa_eligible', label: 'ESA Eligible' },
                { id: 'education_choice_participant', label: 'Education Choice Participant' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <h4 className="font-semibold text-sm pt-3 border-t">Advanced Student Qualifiers</h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'title_i_school', label: 'Attends Title I School' },
                { id: 'iep_504', label: 'IEP/504 Status' },
                { id: 'dual_enrollment', label: 'Dual Enrollment / Early College' },
                { id: 'rotc_jrotc', label: 'ROTC / JROTC' },
                { id: 'civil_air_patrol', label: 'Civil Air Patrol' },
                { id: 'work_study_eligible', label: 'Work-Study Eligible' },
                { id: 'faith_based_college', label: 'Faith-Based College' },
                { id: 'athletics_commitment', label: 'Athletics Commitment' },
                { id: 'arts_commitment', label: 'Arts Commitment' },
              ].map(item => (
                <div key={item.id} className="flex items-center space-x-2">
                  <Checkbox id={item.id} checked={currentData[item.id] || false} onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} />
                  <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
                </div>
              ))}
            </div>
            <div>
              <Label className="text-sm font-medium">Free/Reduced Lunch %</Label>
              <Input type="number" step="0.1" value={currentData.frpl_percentage || ''} onChange={(e) => handleFieldUpdate('frpl_percentage', parseFloat(e.target.value) || null)} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium text-slate-700">Current College/University</div>
              <div className="text-slate-600">{safeOrg.current_college || '—'}</div>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-700">Intended Major</div>
              <div className="text-slate-600">{safeOrg.intended_major || '—'}</div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-slate-700">GPA</div>
                <div className="text-slate-600">{safeOrg.gpa ? parseFloat(safeOrg.gpa).toFixed(2) : '—'}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-slate-700">Community Service Hours</div>
                <div className="text-slate-600">{safeOrg.community_service_hours || '—'}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-slate-700">ACT Score</div>
                <div className="text-slate-600">{safeOrg.act_score || '—'}</div>
              </div>
              <div>
                <div className="text-sm font-medium text-slate-700">SAT Score</div>
                <div className="text-slate-600">{safeOrg.sat_score || '—'}</div>
              </div>
            </div>
            {(safeOrg.gre_score || safeOrg.gmat_score || safeOrg.lsat_score || safeOrg.mcat_score) && (
              <div className="grid grid-cols-4 gap-4">
                {safeOrg.gre_score && <div><div className="text-sm font-medium text-slate-700">GRE</div><div className="text-slate-600">{safeOrg.gre_score}</div></div>}
                {safeOrg.gmat_score && <div><div className="text-sm font-medium text-slate-700">GMAT</div><div className="text-slate-600">{safeOrg.gmat_score}</div></div>}
                {safeOrg.lsat_score && <div><div className="text-sm font-medium text-slate-700">LSAT</div><div className="text-slate-600">{safeOrg.lsat_score}</div></div>}
                {safeOrg.mcat_score && <div><div className="text-sm font-medium text-slate-700">MCAT</div><div className="text-slate-600">{safeOrg.mcat_score}</div></div>}
              </div>
            )}
            {(safeOrg.cte_pathway || safeOrg.idea_disability_category || safeOrg.efc_sai_band || safeOrg.student_housing_status) && (
              <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                {safeOrg.cte_pathway && <div><div className="text-sm font-medium text-slate-700">CTE Pathway</div><div className="text-slate-600">{safeOrg.cte_pathway}</div></div>}
                {safeOrg.idea_disability_category && <div><div className="text-sm font-medium text-slate-700">IDEA Category</div><div className="text-slate-600">{safeOrg.idea_disability_category}</div></div>}
                {safeOrg.efc_sai_band && <div><div className="text-sm font-medium text-slate-700">EFC/SAI Band</div><div className="text-slate-600">{safeOrg.efc_sai_band}</div></div>}
                {safeOrg.student_housing_status && <div><div className="text-sm font-medium text-slate-700">Housing Status</div><div className="text-slate-600">{safeOrg.student_housing_status.replace(/_/g, ' ')}</div></div>}
              </div>
            )}
            {/* Academic Characteristics */}
            <div className="flex flex-wrap gap-2 pt-2">
              {safeOrg.first_generation && <Badge className="bg-indigo-100 text-indigo-800">First-Generation</Badge>}
              {safeOrg.stem_student && <Badge className="bg-indigo-100 text-indigo-800">STEM Student</Badge>}
              {safeOrg.arts_humanities_field && <Badge className="bg-indigo-100 text-indigo-800">Arts/Humanities</Badge>}
              {safeOrg.medical_nursing_field && <Badge className="bg-indigo-100 text-indigo-800">Medical/Nursing</Badge>}
              {safeOrg.education_social_work_field && <Badge className="bg-indigo-100 text-indigo-800">Education/Social Work</Badge>}
              {safeOrg.trade_apprenticeship_participant && <Badge className="bg-indigo-100 text-indigo-800">Trade/Apprenticeship</Badge>}
              {safeOrg.ged_graduate && <Badge className="bg-indigo-100 text-indigo-800">GED Graduate</Badge>}
              {safeOrg.returning_adult_student && <Badge className="bg-indigo-100 text-indigo-800">Returning Adult</Badge>}
              {safeOrg.recent_graduate && <Badge className="bg-indigo-100 text-indigo-800">Recent Graduate</Badge>}
              {safeOrg.pell_eligible && <Badge className="bg-green-100 text-green-800">Pell Eligible</Badge>}
              {safeOrg.fafsa_completed && <Badge className="bg-green-100 text-green-800">FAFSA Completed</Badge>}
              {safeOrg.student_with_dependents && <Badge className="bg-indigo-100 text-indigo-800">Student with Dependents</Badge>}
              {/* Education Type */}
              {safeOrg.homeschool_family && <Badge className="bg-purple-100 text-purple-800">Homeschool</Badge>}
              {safeOrg.private_school_student && <Badge className="bg-purple-100 text-purple-800">Private School</Badge>}
              {safeOrg.charter_school_student && <Badge className="bg-purple-100 text-purple-800">Charter School</Badge>}
              {safeOrg.virtual_academy_student && <Badge className="bg-purple-100 text-purple-800">Virtual Academy</Badge>}
              {safeOrg.parent_led_education && <Badge className="bg-purple-100 text-purple-800">Parent-Led Education</Badge>}
              {safeOrg.homeschool_coop_member && <Badge className="bg-purple-100 text-purple-800">Homeschool Co-op</Badge>}
              {safeOrg.esa_eligible && <Badge className="bg-purple-100 text-purple-800">ESA Eligible</Badge>}
              {safeOrg.education_choice_participant && <Badge className="bg-purple-100 text-purple-800">Education Choice</Badge>}
              {/* Advanced Qualifiers */}
              {safeOrg.title_i_school && <Badge className="bg-amber-100 text-amber-800">Title I School</Badge>}
              {safeOrg.iep_504 && <Badge className="bg-amber-100 text-amber-800">IEP/504</Badge>}
              {safeOrg.dual_enrollment && <Badge className="bg-amber-100 text-amber-800">Dual Enrollment</Badge>}
              {safeOrg.rotc_jrotc && <Badge className="bg-amber-100 text-amber-800">ROTC/JROTC</Badge>}
              {safeOrg.civil_air_patrol && <Badge className="bg-amber-100 text-amber-800">Civil Air Patrol</Badge>}
              {safeOrg.work_study_eligible && <Badge className="bg-amber-100 text-amber-800">Work-Study Eligible</Badge>}
              {safeOrg.faith_based_college && <Badge className="bg-amber-100 text-amber-800">Faith-Based College</Badge>}
              {safeOrg.athletics_commitment && <Badge className="bg-amber-100 text-amber-800">Athletics</Badge>}
              {safeOrg.arts_commitment && <Badge className="bg-amber-100 text-amber-800">Arts Commitment</Badge>}
            </div>
            {safeOrg.frpl_percentage && (
              <div className="pt-2">
                <div className="text-sm font-medium text-slate-700">Free/Reduced Lunch %</div>
                <div className="text-slate-600">{safeOrg.frpl_percentage}%</div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 pt-4 border-t">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-slate-700">Target/Interested Colleges</div>
            {applications.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handlePullFromApplications}
                disabled={isPulling || isUpdating}
                className="text-xs"
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${isPulling ? 'animate-spin' : ''}`} />
                Pull from Applications ({applications.length})
              </Button>
            )}
          </div>
          <EditableTagList
            tags={safeOrg.target_colleges || []}
            onUpdate={(newTags) => onUpdate && safeOrg.id && onUpdate({ id: safeOrg.id, data: { target_colleges: newTags }})}
            placeholder="Add colleges..."
            disabled={isUpdating}
          />
        </div>

        <div className="mt-4 pt-4 border-t">
          <div className="text-sm font-medium text-slate-700 mb-2">Extracurricular Activities</div>
          <EditableTagList
            tags={safeOrg.extracurricular_activities || []}
            onUpdate={(newTags) => onUpdate && safeOrg.id && onUpdate({ id: safeOrg.id, data: { extracurricular_activities: newTags }})}
            placeholder="Add activities..."
            disabled={isUpdating}
          />
        </div>

        <div className="mt-4 pt-4 border-t">
          <div className="text-sm font-medium text-slate-700 mb-2">Achievements</div>
          <EditableTagList
            tags={safeOrg.awards_achievements || []}
            onUpdate={(newTags) => onUpdate && safeOrg.id && onUpdate({ id: safeOrg.id, data: { awards_achievements: newTags }})}
            placeholder="Add achievements..."
            disabled={isUpdating}
          />
        </div>
      </CardContent>
    </Card>
  );
}