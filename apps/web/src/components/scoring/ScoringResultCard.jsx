import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ThumbsUp, ThumbsDown, Lightbulb, Puzzle, CheckCircle, Target, BookOpen, Scaling } from 'lucide-react';

const calculatePercentage = (score, max) => {
  if (!max || max === 0) return 0;
  return Math.min((score / max) * 100, 100);
};

const getProgressColor = (score, max) => {
  const percentage = calculatePercentage(score, max);
  if (percentage >= 80) return "bg-emerald-500";
  if (percentage >= 60) return "bg-yellow-500";
  return "bg-red-500";
};

const ScoreCategory = ({ title, score, maxScore = 25, icon: Icon, description }) => {
  const percentage = calculatePercentage(score, maxScore);
  const progressColor = getProgressColor(score, maxScore);

  return (
    <div className="p-4 bg-white rounded-xl border shadow-sm" role="article" aria-label={`${title} score`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-5 h-5 text-purple-600 flex-shrink-0" aria-hidden="true" />
          <span className="font-semibold text-slate-800 text-sm sm:text-base truncate">{title}</span>
        </div>
        <span className="font-bold text-lg text-purple-700 whitespace-nowrap" aria-label={`Score: ${score} out of ${maxScore}`}>
          {score}/{maxScore}
        </span>
      </div>
      <Progress value={percentage} className="h-2" indicatorClassName={progressColor} aria-valuenow={score} aria-valuemin="0" aria-valuemax={maxScore} />
      <p className="text-xs text-slate-500 mt-2">{description}</p>
    </div>
  );
};

const FeedbackSection = ({ title, items = [], icon: Icon, bgColor, borderColor, textColor, emptyMessage = "No items to display" }) => {
  const hasItems = items && items.length > 0;

  return (
    <div className={`p-4 ${bgColor} border ${borderColor} rounded-xl`} role="region" aria-label={title}>
      <h4 className={`font-semibold ${textColor} flex items-center gap-2 mb-3`}>
        <Icon className="w-5 h-5" aria-hidden="true" />
        {title}
      </h4>
      {hasItems ? (
        <ul className={`space-y-2 list-disc list-inside ${textColor}`} role="list">
          {items.map((item, i) => (
            <li key={i} className="text-sm leading-relaxed">{item}</li>
          ))}
        </ul>
      ) : (
        <p className={`text-sm ${textColor} opacity-70 italic`}>{emptyMessage}</p>
      )}
    </div>
  );
};

export default function ScoringResultCard({ result, maxCategoryScore = 25, maxTotalScore = 100 }) {
  if (!result) return null;

  const scoreCategories = [
    {
      title: "Responsiveness",
      score: result.responsiveness_score || 0,
      icon: Target,
      description: "Addresses funder goals"
    },
    {
      title: "Clarity & Persuasiveness",
      score: result.clarity_score || 0,
      icon: BookOpen,
      description: "Clear and compelling narrative"
    },
    {
      title: "Impact",
      score: result.impact_score || 0,
      icon: Scaling,
      description: "Significance of outcomes"
    },
    {
      title: "Feasibility",
      score: result.feasibility_score || 0,
      icon: CheckCircle,
      description: "Likelihood of success"
    },
  ];

  const totalScore = result.total_score || 0;
  const totalPercentage = calculatePercentage(totalScore, maxTotalScore);
  const hasMissingInfo = result.missing_information && result.missing_information.length > 0;

  return (
    <Card className="shadow-2xl border-0 bg-gradient-to-br from-slate-50 to-purple-50" role="article" aria-label="Scoring results">
      <CardHeader>
        <div className="text-center">
          <CardDescription>Overall Score</CardDescription>
          <CardTitle className="text-5xl sm:text-6xl md:text-7xl font-bold text-purple-600 my-2" aria-label={`Total score: ${totalScore} out of ${maxTotalScore}`}>
            {totalScore}/{maxTotalScore}
          </CardTitle>
          <Progress 
            value={totalPercentage} 
            className="w-full sm:w-3/4 md:w-1/2 mx-auto h-3" 
            aria-valuenow={totalScore} 
            aria-valuemin="0" 
            aria-valuemax={maxTotalScore}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-6 sm:space-y-8 p-4 sm:p-6">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-4 text-center">Score Breakdown</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            {scoreCategories.map(cat => (
              <ScoreCategory
                key={cat.title}
                title={cat.title}
                score={cat.score}
                maxScore={maxCategoryScore}
                icon={cat.icon}
                description={cat.description}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          <FeedbackSection
            title="Strengths"
            items={result.strengths}
            icon={ThumbsUp}
            bgColor="bg-emerald-50"
            borderColor="border-emerald-200"
            textColor="text-emerald-900"
            emptyMessage="No strengths identified"
          />
          <FeedbackSection
            title="Areas for Improvement"
            items={result.weaknesses}
            icon={ThumbsDown}
            bgColor="bg-red-50"
            borderColor="border-red-200"
            textColor="text-red-900"
            emptyMessage="No areas for improvement identified"
          />
        </div>

        <FeedbackSection
          title="Actionable Suggestions"
          items={result.suggestions}
          icon={Lightbulb}
          bgColor="bg-blue-50"
          borderColor="border-blue-200"
          textColor="text-blue-900"
          emptyMessage="No suggestions available"
        />
        
        {hasMissingInfo && (
          <FeedbackSection
            title="Missing Information"
            items={result.missing_information}
            icon={Puzzle}
            bgColor="bg-amber-50"
            borderColor="border-amber-200"
            textColor="text-amber-900"
            emptyMessage="No missing information detected"
          />
        )}
      </CardContent>
    </Card>
  );
}