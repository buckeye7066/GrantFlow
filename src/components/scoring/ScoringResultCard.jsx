import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ThumbsUp, ThumbsDown, Lightbulb, Puzzle, CheckCircle, Target, BookOpen, Scaling } from 'lucide-react';

export default function ScoringResultCard({ result }) {
  if (!result) return null;

  const scoreCategories = [
    {
      title: "Responsiveness",
      score: result.responsiveness_score,
      icon: Target,
      description: "Addresses funder goals"
    },
    {
      title: "Clarity & Persuasiveness",
      score: result.clarity_score,
      icon: BookOpen,
      description: "Clear and compelling narrative"
    },
    {
      title: "Impact",
      score: result.impact_score,
      icon: Scaling,
      description: "Significance of outcomes"
    },
    {
      title: "Feasibility",
      score: result.feasibility_score,
      icon: CheckCircle,
      description: "Likelihood of success"
    },
  ];

  const getProgressColor = (score) => {
    if (score >= 20) return "bg-emerald-500";
    if (score >= 15) return "bg-yellow-500";
    return "bg-red-500";
  };

  return (
    <Card className="shadow-2xl border-0 bg-gradient-to-br from-slate-50 to-purple-50">
      <CardHeader>
        <div className="text-center">
          <CardDescription>Overall Score</CardDescription>
          <CardTitle className="text-7xl font-bold text-purple-600 my-2">{result.total_score}/100</CardTitle>
          <Progress value={result.total_score} className="w-1/2 mx-auto h-3" />
        </div>
      </CardHeader>
      <CardContent className="space-y-8 p-6">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 text-center">Score Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {scoreCategories.map(cat => (
              <div key={cat.title} className="p-4 bg-white rounded-xl border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <cat.icon className="w-5 h-5 text-purple-600" />
                    <span className="font-semibold text-slate-800">{cat.title}</span>
                  </div>
                  <span className="font-bold text-lg text-purple-700">{cat.score}/25</span>
                </div>
                <Progress value={(cat.score / 25) * 100} className="h-2" indicatorClassName={getProgressColor(cat.score)} />
                 <p className="text-xs text-slate-500 mt-2">{cat.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <h4 className="font-semibold text-emerald-900 flex items-center gap-2 mb-3"><ThumbsUp className="w-5 h-5"/>Strengths</h4>
            <ul className="space-y-2 list-disc list-inside text-emerald-800">
              {result.strengths?.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </div>
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
            <h4 className="font-semibold text-red-900 flex items-center gap-2 mb-3"><ThumbsDown className="w-5 h-5"/>Areas for Improvement</h4>
            <ul className="space-y-2 list-disc list-inside text-red-800">
              {result.weaknesses?.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </div>
        </div>

        <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <h4 className="font-semibold text-blue-900 flex items-center gap-2 mb-3"><Lightbulb className="w-5 h-5"/>Actionable Suggestions</h4>
          <ul className="space-y-2 list-disc list-inside text-blue-800">
            {result.suggestions?.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
        
        {result.missing_information && result.missing_information.length > 0 && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <h4 className="font-semibold text-amber-900 flex items-center gap-2 mb-3"><Puzzle className="w-5 h-5"/>Missing Information</h4>
            <ul className="space-y-2 list-disc list-inside text-amber-800">
              {result.missing_information?.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}