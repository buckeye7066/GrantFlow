import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Building2, 
  Search, 
  Layers, 
  Brain, 
  FileText, 
  Calendar,
  DollarSign,
  Users,
  Zap,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  GraduationCap,
  Target,
  BarChart3,
  Mail,
  Shield
} from 'lucide-react';

const onboardingSteps = [
  {
    title: "Welcome to GrantFlow! 🎉",
    icon: Target,
    color: "bg-blue-500",
    content: (
      <div className="space-y-4">
        <p className="text-lg">
          GrantFlow is your all-in-one platform for finding, tracking, and winning grants 
          for nonprofits, students, and individuals.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-blue-50 rounded-lg">
            <p className="font-semibold text-blue-900">For Nonprofits</p>
            <p className="text-sm text-blue-700">Federal & foundation grants</p>
          </div>
          <div className="p-3 bg-purple-50 rounded-lg">
            <p className="font-semibold text-purple-900">For Students</p>
            <p className="text-sm text-purple-700">Scholarships & FAFSA help</p>
          </div>
          <div className="p-3 bg-green-50 rounded-lg">
            <p className="font-semibold text-green-900">For Individuals</p>
            <p className="text-sm text-green-700">Medical & personal assistance</p>
          </div>
          <div className="p-3 bg-amber-50 rounded-lg">
            <p className="font-semibold text-amber-900">AI-Powered</p>
            <p className="text-sm text-amber-700">Smart matching & writing</p>
          </div>
        </div>
      </div>
    )
  },
  {
    title: "Step 1: Create Your Profile",
    icon: Building2,
    color: "bg-emerald-500",
    content: (
      <div className="space-y-4">
        <p>Start by creating an <strong>Organization Profile</strong>. This can be:</p>
        <ul className="space-y-2">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
            <span><strong>Nonprofit organization</strong> - with EIN, mission, budget info</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
            <span><strong>Student</strong> - high school, college, or graduate</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
            <span><strong>Individual</strong> - for personal assistance grants</span>
          </li>
        </ul>
        <div className="p-3 bg-blue-50 rounded-lg text-sm">
          <strong>💡 Tip:</strong> The more complete your profile, the better our AI can match you with relevant opportunities.
        </div>
      </div>
    )
  },
  {
    title: "Step 2: Discover Grants",
    icon: Search,
    color: "bg-purple-500",
    content: (
      <div className="space-y-4">
        <p>Find funding opportunities using our powerful search tools:</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Search className="w-5 h-5 text-purple-600 mt-0.5" />
            <div>
              <p className="font-semibold">Discover Grants</p>
              <p className="text-sm text-slate-600">Search grants.gov, foundations, and more</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Brain className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-semibold">Smart Matcher</p>
              <p className="text-sm text-slate-600">AI analyzes your profile to find best matches</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Target className="w-5 h-5 text-green-600 mt-0.5" />
            <div>
              <p className="font-semibold">Profile Matcher</p>
              <p className="text-sm text-slate-600">See match scores for each opportunity</p>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    title: "Step 3: Manage Your Pipeline",
    icon: Layers,
    color: "bg-amber-500",
    content: (
      <div className="space-y-4">
        <p>Track grants through every stage with the <strong>Pipeline</strong>:</p>
        <div className="flex flex-wrap gap-2">
          <Badge className="bg-slate-100 text-slate-800">Discovered</Badge>
          <Badge className="bg-blue-100 text-blue-800">Interested</Badge>
          <Badge className="bg-purple-100 text-purple-800">Drafting</Badge>
          <Badge className="bg-amber-100 text-amber-800">App Prep</Badge>
          <Badge className="bg-orange-100 text-orange-800">Revision</Badge>
          <Badge className="bg-green-100 text-green-800">Submitted</Badge>
          <Badge className="bg-emerald-100 text-emerald-800">Awarded</Badge>
        </div>
        <p className="text-sm text-slate-600">
          Drag and drop grants between stages, or let our AI automation advance them automatically.
        </p>
        <div className="p-3 bg-amber-50 rounded-lg text-sm">
          <strong>⚡ Pro Tip:</strong> Use "Process All" on the Dashboard to let AI analyze all your grants at once.
        </div>
      </div>
    )
  },
  {
    title: "Step 4: AI Proposal Writing",
    icon: FileText,
    color: "bg-indigo-500",
    content: (
      <div className="space-y-4">
        <p>Let AI help you write winning proposals:</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Brain className="w-5 h-5 text-indigo-600 mt-0.5" />
            <div>
              <p className="font-semibold">AI Coach</p>
              <p className="text-sm text-slate-600">Get personalized guidance and feedback</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <FileText className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-semibold">Proposal Writer</p>
              <p className="text-sm text-slate-600">Generate full drafts or individual sections</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <DollarSign className="w-5 h-5 text-green-600 mt-0.5" />
            <div>
              <p className="font-semibold">Budget Builder</p>
              <p className="text-sm text-slate-600">Create compliant budget justifications</p>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    title: "For Students: FAFSA & Scholarships",
    icon: GraduationCap,
    color: "bg-pink-500",
    content: (
      <div className="space-y-4">
        <p>Special features for student applicants:</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-pink-50 rounded-lg">
            <GraduationCap className="w-5 h-5 text-pink-600 mt-0.5" />
            <div>
              <p className="font-semibold">FAFSA Tracking</p>
              <p className="text-sm text-pink-700">Monitor your FAFSA status and deadlines</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
            <FileText className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-semibold">IRS Data Tools</p>
              <p className="text-sm text-blue-700">Quick links to tax transcripts & DRT</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-purple-50 rounded-lg">
            <Search className="w-5 h-5 text-purple-600 mt-0.5" />
            <div>
              <p className="font-semibold">Scholarship Search</p>
              <p className="text-sm text-purple-700">Find scholarships matched to your profile</p>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    title: "Stay Organized",
    icon: Calendar,
    color: "bg-teal-500",
    content: (
      <div className="space-y-4">
        <p>Never miss a deadline with these tools:</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Calendar className="w-5 h-5 text-teal-600 mt-0.5" />
            <div>
              <p className="font-semibold">Deadline Reminders</p>
              <p className="text-sm text-slate-600">Email alerts 7, 3, and 1 day before due dates</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <BarChart3 className="w-5 h-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-semibold">Grant Monitoring</p>
              <p className="text-sm text-slate-600">Track awarded grant compliance & reporting</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Shield className="w-5 h-5 text-green-600 mt-0.5" />
            <div>
              <p className="font-semibold">Stewardship</p>
              <p className="text-sm text-slate-600">Manage funder relationships & reports</p>
            </div>
          </div>
        </div>
      </div>
    )
  },
  {
    title: "You're Ready! 🚀",
    icon: Zap,
    color: "bg-gradient-to-r from-blue-500 to-purple-500",
    content: (
      <div className="space-y-4">
        <p className="text-lg">Here's how to get started right now:</p>
        <ol className="space-y-3">
          <li className="flex items-start gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 font-bold text-sm">1</span>
            <span>Go to <strong>Organizations</strong> and create your first profile</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 font-bold text-sm">2</span>
            <span>Use <strong>Discover Grants</strong> to find opportunities</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 font-bold text-sm">3</span>
            <span>Add interesting grants to your <strong>Pipeline</strong></span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-amber-700 font-bold text-sm">4</span>
            <span>Let the <strong>AI Coach</strong> help you apply!</span>
          </li>
        </ol>
        <div className="p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg text-center">
          <p className="font-semibold text-slate-900">Need help?</p>
          <p className="text-sm text-slate-600">Use "Contact Admin" in the sidebar to reach us anytime.</p>
        </div>
      </div>
    )
  }
];

export default function OnboardingGuide({ open, onClose }) {
  const [currentStep, setCurrentStep] = useState(0);
  
  const step = onboardingSteps[currentStep];
  const Icon = step.icon;
  const isFirst = currentStep === 0;
  const isLast = currentStep === onboardingSteps.length - 1;

  const handleNext = () => {
    if (isLast) {
      onClose();
    } else {
      setCurrentStep(prev => prev + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirst) {
      setCurrentStep(prev => prev - 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className={`w-10 h-10 rounded-lg ${step.color} flex items-center justify-center`}>
              <Icon className="w-6 h-6 text-white" />
            </div>
            <DialogTitle className="text-xl">{step.title}</DialogTitle>
          </div>
          {/* Progress dots */}
          <div className="flex items-center gap-1.5 pt-2">
            {onboardingSteps.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentStep(idx)}
                className={`h-2 rounded-full transition-all ${
                  idx === currentStep 
                    ? 'w-6 bg-blue-600' 
                    : idx < currentStep 
                      ? 'w-2 bg-blue-300' 
                      : 'w-2 bg-slate-200'
                }`}
              />
            ))}
          </div>
        </DialogHeader>

        <div className="py-4">
          {step.content}
        </div>

        <div className="flex items-center justify-between pt-4 border-t">
          <Button
            variant="ghost"
            onClick={handlePrev}
            disabled={isFirst}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          
          <span className="text-sm text-slate-500">
            {currentStep + 1} of {onboardingSteps.length}
          </span>

          <Button onClick={handleNext}>
            {isLast ? (
              <>Get Started</>
            ) : (
              <>
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}