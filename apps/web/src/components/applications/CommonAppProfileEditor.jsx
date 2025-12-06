import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Plus, X, Trash2, Save, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const ESSAY_PROMPTS = [
  "Some students have a background, identity, interest, or talent...",
  "The lessons we take from obstacles we encounter...",
  "Reflect on a time when you questioned or challenged a belief...",
  "Reflect on something that someone has done for you...",
  "Discuss an accomplishment, event, or realization...",
  "Describe a topic, idea, or concept you find engaging...",
  "Share an essay on any topic of your choice..."
];

const ACTIVITY_TYPES = [
  "Academic", "Art", "Athletics: Club", "Athletics: JV/Varsity", 
  "Career Oriented", "Community Service", "Computer/Technology",
  "Cultural", "Dance", "Debate/Speech", "Environmental", "Family Responsibilities",
  "Foreign Exchange", "Journalism/Publication", "Junior R.O.T.C.", "LGBT",
  "Music: Instrumental", "Music: Vocal", "Religious", "Research", "Robotics",
  "School Spirit", "Science/Math", "Social Justice", "Student Gov./Politics",
  "Theater/Drama", "Work (Paid)", "Other Club/Activity"
];

const HONOR_LEVELS = [
  { value: "school", label: "School" },
  { value: "state", label: "State/Regional" },
  { value: "national", label: "National" },
  { value: "international", label: "International" }
];

export default function CommonAppProfileEditor({ organizationId }) {
  const queryClient = useQueryClient();
  const [isExpanded, setIsExpanded] = useState(false);
  const [editingActivity, setEditingActivity] = useState(null);
  const [editingHonor, setEditingHonor] = useState(null);

  // Fetch existing Common App profile
  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['commonAppProfile', organizationId],
    queryFn: () => base44.entities.CommonAppProfile.filter({ organization_id: organizationId }),
    enabled: !!organizationId
  });

  const profile = profiles[0] || null;

  // Create profile mutation
  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.CommonAppProfile.create({
      organization_id: organizationId,
      ...data
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commonAppProfile', organizationId] });
      toast.success('Common App profile created');
    }
  });

  // Update profile mutation
  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.CommonAppProfile.update(profile.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commonAppProfile', organizationId] });
      toast.success('Saved');
    }
  });

  const [formData, setFormData] = useState({
    personal_essay: profile?.personal_essay || '',
    personal_essay_prompt: profile?.personal_essay_prompt || '',
    activities: profile?.activities || [],
    honors: profile?.honors || [],
    additional_info: profile?.additional_info || ''
  });

  // Sync form data when profile loads
  React.useEffect(() => {
    if (profile) {
      setFormData({
        personal_essay: profile.personal_essay || '',
        personal_essay_prompt: profile.personal_essay_prompt || '',
        activities: profile.activities || [],
        honors: profile.honors || [],
        additional_info: profile.additional_info || ''
      });
    }
  }, [profile]);

  const handleSave = () => {
    if (profile) {
      updateMutation.mutate(formData);
    } else {
      createMutation.mutate(formData);
    }
  };

  const addActivity = () => {
    if (formData.activities.length >= 10) {
      toast.error('Maximum 10 activities allowed');
      return;
    }
    setEditingActivity({
      activity_type: '',
      position: '',
      organization_name: '',
      description: '',
      grades: [],
      hours_per_week: 0,
      weeks_per_year: 0
    });
  };

  const saveActivity = () => {
    if (!editingActivity.activity_type || !editingActivity.organization_name) {
      toast.error('Activity type and organization name are required');
      return;
    }
    
    const activities = [...formData.activities, editingActivity];
    setFormData({ ...formData, activities });
    setEditingActivity(null);
  };

  const removeActivity = (index) => {
    const activities = formData.activities.filter((_, i) => i !== index);
    setFormData({ ...formData, activities });
  };

  const addHonor = () => {
    if (formData.honors.length >= 5) {
      toast.error('Maximum 5 honors allowed');
      return;
    }
    setEditingHonor({
      title: '',
      level: 'school',
      grades: []
    });
  };

  const saveHonor = () => {
    if (!editingHonor.title) {
      toast.error('Honor title is required');
      return;
    }
    
    const honors = [...formData.honors, editingHonor];
    setFormData({ ...formData, honors });
    setEditingHonor(null);
  };

  const removeHonor = (index) => {
    const honors = formData.honors.filter((_, i) => i !== index);
    setFormData({ ...formData, honors });
  };

  const wordCount = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-400" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-purple-200 bg-purple-50/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-purple-900">
            <FileText className="w-5 h-5" />
            Common App Profile
          </CardTitle>
          <Button 
            variant="ghost" 
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-sm text-purple-700">
          Store your essays and activities once, use across all Common App schools
        </p>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-6">
          {/* Personal Essay */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Personal Essay (650 words max)</Label>
            <Select 
              value={formData.personal_essay_prompt} 
              onValueChange={(v) => setFormData({ ...formData, personal_essay_prompt: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select prompt..." />
              </SelectTrigger>
              <SelectContent>
                {ESSAY_PROMPTS.map((prompt, idx) => (
                  <SelectItem key={idx} value={prompt} className="text-xs">
                    {prompt.slice(0, 60)}...
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Write your personal essay here..."
              value={formData.personal_essay}
              onChange={(e) => setFormData({ ...formData, personal_essay: e.target.value })}
              className="min-h-[200px] bg-white"
            />
            <div className="flex justify-between text-xs">
              <span className={wordCount(formData.personal_essay) > 650 ? 'text-red-600' : 'text-slate-500'}>
                {wordCount(formData.personal_essay)} / 650 words
              </span>
              {wordCount(formData.personal_essay) > 650 && (
                <span className="text-red-600">Over limit!</span>
              )}
            </div>
          </div>

          {/* Activities */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Activities ({formData.activities.length}/10)</Label>
              <Button size="sm" variant="outline" onClick={addActivity} disabled={formData.activities.length >= 10}>
                <Plus className="w-3 h-3 mr-1" /> Add Activity
              </Button>
            </div>

            {formData.activities.map((activity, idx) => (
              <div key={idx} className="p-3 bg-white rounded-lg border space-y-1">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-sm">{activity.organization_name}</p>
                    <p className="text-xs text-slate-600">{activity.activity_type} • {activity.position}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeActivity(idx)}>
                    <Trash2 className="w-3 h-3 text-red-500" />
                  </Button>
                </div>
                {activity.description && (
                  <p className="text-xs text-slate-500 line-clamp-2">{activity.description}</p>
                )}
                <div className="flex gap-2 text-xs text-slate-500">
                  <span>{activity.hours_per_week} hrs/week</span>
                  <span>•</span>
                  <span>{activity.weeks_per_year} weeks/year</span>
                </div>
              </div>
            ))}

            {/* Add Activity Form */}
            {editingActivity && (
              <div className="p-4 bg-white rounded-lg border-2 border-dashed border-purple-300 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Activity Type</Label>
                    <Select 
                      value={editingActivity.activity_type}
                      onValueChange={(v) => setEditingActivity({ ...editingActivity, activity_type: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTIVITY_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>{type}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Position/Leadership</Label>
                    <Input
                      placeholder="e.g., President, Member"
                      value={editingActivity.position}
                      onChange={(e) => setEditingActivity({ ...editingActivity, position: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Organization Name</Label>
                  <Input
                    placeholder="Name of club, team, or organization"
                    value={editingActivity.organization_name}
                    onChange={(e) => setEditingActivity({ ...editingActivity, organization_name: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Description (150 characters)</Label>
                  <Textarea
                    placeholder="Describe your involvement..."
                    value={editingActivity.description}
                    onChange={(e) => setEditingActivity({ ...editingActivity, description: e.target.value.slice(0, 150) })}
                    className="h-16"
                  />
                  <span className="text-xs text-slate-400">{editingActivity.description?.length || 0}/150</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Hours/Week</Label>
                    <Input
                      type="number"
                      value={editingActivity.hours_per_week}
                      onChange={(e) => setEditingActivity({ ...editingActivity, hours_per_week: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Weeks/Year</Label>
                    <Input
                      type="number"
                      value={editingActivity.weeks_per_year}
                      onChange={(e) => setEditingActivity({ ...editingActivity, weeks_per_year: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveActivity}>Save Activity</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingActivity(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {/* Honors */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Honors & Awards ({formData.honors.length}/5)</Label>
              <Button size="sm" variant="outline" onClick={addHonor} disabled={formData.honors.length >= 5}>
                <Plus className="w-3 h-3 mr-1" /> Add Honor
              </Button>
            </div>

            {formData.honors.map((honor, idx) => (
              <div key={idx} className="p-3 bg-white rounded-lg border flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{honor.title}</p>
                  <Badge variant="outline" className="text-xs capitalize">{honor.level}</Badge>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeHonor(idx)}>
                  <Trash2 className="w-3 h-3 text-red-500" />
                </Button>
              </div>
            ))}

            {/* Add Honor Form */}
            {editingHonor && (
              <div className="p-4 bg-white rounded-lg border-2 border-dashed border-purple-300 space-y-3">
                <div>
                  <Label className="text-xs">Honor/Award Title</Label>
                  <Input
                    placeholder="e.g., National Merit Scholar"
                    value={editingHonor.title}
                    onChange={(e) => setEditingHonor({ ...editingHonor, title: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Level of Recognition</Label>
                  <Select 
                    value={editingHonor.level}
                    onValueChange={(v) => setEditingHonor({ ...editingHonor, level: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HONOR_LEVELS.map((level) => (
                        <SelectItem key={level.value} value={level.value}>{level.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveHonor}>Save Honor</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingHonor(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {/* Additional Information */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Additional Information (650 words max)</Label>
            <Textarea
              placeholder="Any additional context you'd like colleges to know..."
              value={formData.additional_info}
              onChange={(e) => setFormData({ ...formData, additional_info: e.target.value })}
              className="min-h-[100px] bg-white"
            />
            <span className={`text-xs ${wordCount(formData.additional_info) > 650 ? 'text-red-600' : 'text-slate-500'}`}>
              {wordCount(formData.additional_info)} / 650 words
            </span>
          </div>

          {/* Save Button */}
          <Button 
            onClick={handleSave} 
            className="w-full"
            disabled={createMutation.isPending || updateMutation.isPending}
          >
            {(createMutation.isPending || updateMutation.isPending) ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
            ) : (
              <><Save className="w-4 h-4 mr-2" /> Save Common App Profile</>
            )}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}