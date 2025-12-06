import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Search, Target, FileText, DollarSign, BarChart3, CheckCircle2 } from 'lucide-react';

/**
 * Preview of app features for public applicants
 * Shows what they get access to after becoming a client
 */
export default function AppPreview() {
  const features = [
    {
      icon: Search,
      title: 'Smart Grant Discovery',
      description: 'AI-powered search across 100,000+ funding opportunities from federal, state, foundation, and corporate sources',
      color: 'text-blue-600',
      bgColor: 'bg-blue-50'
    },
    {
      icon: Target,
      title: 'Intelligent Matching',
      description: 'Automatic profile-to-grant matching that identifies the best opportunities for your specific needs and qualifications',
      color: 'text-purple-600',
      bgColor: 'bg-purple-50'
    },
    {
      icon: FileText,
      title: 'AI-Assisted Writing',
      description: 'Guided application wizard with AI suggestions for narratives, budgets, and compliance documentation',
      color: 'text-green-600',
      bgColor: 'bg-green-50'
    },
    {
      icon: DollarSign,
      title: 'Budget Management',
      description: 'Professional budget templates, expense tracking, and financial reporting tools',
      color: 'text-amber-600',
      bgColor: 'bg-amber-50'
    },
    {
      icon: BarChart3,
      title: 'Pipeline Tracking',
      description: 'Visual Kanban board to manage all your applications from discovery through award and compliance',
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-50'
    },
    {
      icon: CheckCircle2,
      title: 'Deadline Alerts',
      description: 'Never miss a deadline with automated reminders, milestone tracking, and submission checklists',
      color: 'text-rose-600',
      bgColor: 'bg-rose-50'
    }
  ];

  return (
    <Card className="border-2 border-slate-200">
      <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white">
        <CardTitle className="text-xl">What You'll Get Access To</CardTitle>
        <p className="text-sm text-blue-50 mt-2">
          Professional grant management platform included with all services
        </p>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="grid gap-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className={`p-4 rounded-lg border border-slate-200 ${feature.bgColor}/30 hover:shadow-md transition-shadow`}>
                <div className="flex gap-3">
                  <div className={`p-2 rounded-lg ${feature.bgColor}`}>
                    <Icon className={`w-5 h-5 ${feature.color}`} />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-slate-900 mb-1">{feature.title}</h4>
                    <p className="text-sm text-slate-600">{feature.description}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        <div className="mt-6 p-4 bg-gradient-to-r from-slate-50 to-slate-100 rounded-lg border border-slate-200">
          <p className="text-sm text-slate-700 leading-relaxed">
            <strong>Plus:</strong> Document library, compliance calendar, automated email outreach, 
            real-time grant monitoring, and dedicated consultant support throughout your funding journey.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}