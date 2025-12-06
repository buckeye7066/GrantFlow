import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Lightbulb, ThumbsUp, ThumbsDown, Sparkles, Loader2, Wand2, Check } from 'lucide-react';

const ICON_COLOR_MAP = {
    strengths: { color: 'text-emerald-600', bg: 'bg-emerald-50' },
    weaknesses: { color: 'text-amber-600', bg: 'bg-amber-50' },
    suggestions: { color: 'text-blue-600', bg: 'bg-blue-50' },
};

export default function CoachFeedback({ feedback, onImprove, isImproving, improvedItems = [] }) {
    if (!feedback) {
        return (
            <Card className="bg-slate-50 border-slate-200">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Lightbulb className="w-5 h-5 text-blue-600" aria-hidden="true" />
                        AI Coach
                    </CardTitle>
                    <CardDescription>
                        Click "Get AI Coach Feedback" above to analyze this section.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    const feedbackSections = [
        { 
            title: 'Strengths', 
            icon: ThumbsUp, 
            items: feedback.strengths, 
            key: 'strengths',
            improvable: false 
        },
        { 
            title: 'Areas for Improvement', 
            icon: ThumbsDown, 
            items: feedback.weaknesses, 
            key: 'weaknesses',
            improvable: true 
        },
        { 
            title: 'Actionable Suggestions', 
            icon: Sparkles, 
            items: feedback.suggestions, 
            key: 'suggestions',
            improvable: true 
        },
    ];

    return (
        <Card className="bg-slate-50 border-slate-200 shadow-inner">
            <CardHeader>
                <CardTitle className="flex items-center gap-2" role="heading" aria-level="3">
                    <Lightbulb className="w-5 h-5 text-blue-600" aria-hidden="true" />
                    AI Coach Feedback
                </CardTitle>
                <CardDescription>
                    Review the AI's analysis of your draft. Use "Improve with AI" to automatically apply suggestions.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {feedbackSections.map(section => {
                    const hasItems = section.items && section.items.length > 0;
                    const colors = ICON_COLOR_MAP[section.key];

                    return (
                        <div key={section.title}>
                            <h4 
                                className={`flex items-center gap-2 font-semibold mb-3 ${colors.color}`}
                                role="heading"
                                aria-level="4"
                            >
                                <section.icon className="w-5 h-5" aria-hidden="true" />
                                {section.title}
                            </h4>
                            {hasItems ? (
                                <ul className="space-y-3" role="list">
                                    {section.items.map((item, index) => {
                                        const itemId = `${section.key}-${index}`;
                                        const isLoadingThisItem = isImproving === itemId;
                                        const wasImproved = improvedItems.includes(itemId);
                                        
                                        const buttonContent = (() => {
                                            if (isLoadingThisItem) {
                                                return (
                                                    <>
                                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                                                        Improving...
                                                    </>
                                                );
                                            }
                                            if (wasImproved) {
                                                return (
                                                    <>
                                                        <Check className="w-4 h-4 mr-2" aria-hidden="true" />
                                                        Applied
                                                    </>
                                                );
                                            }
                                            return (
                                                <>
                                                    <Wand2 className="w-4 h-4 mr-2" aria-hidden="true" />
                                                    Improve with AI
                                                </>
                                            );
                                        })();

                                        return (
                                            <li 
                                                key={index} 
                                                className={`p-3 rounded-lg border flex justify-between items-start gap-3 ${colors.bg}`}
                                            >
                                                <p className="text-sm text-slate-800 flex-1 pt-1">{item}</p>
                                                {section.improvable && onImprove && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => onImprove(item, itemId)}
                                                        disabled={!!isImproving || wasImproved}
                                                        aria-label={`Improve suggestion: ${item.substring(0, 50)}...`}
                                                    >
                                                        {buttonContent}
                                                    </Button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : (
                                <p className="text-sm text-slate-500 italic p-3">
                                    {section.key === 'strengths' && 'No strengths identified yet.'}
                                    {section.key === 'weaknesses' && 'No areas for improvement identified.'}
                                    {section.key === 'suggestions' && 'No suggestions available.'}
                                </p>
                            )}
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}