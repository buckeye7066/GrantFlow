import React, { useState, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { 
  X, 
  CheckCircle2, 
  Circle, 
  Clock, 
  Play,
  ChevronRight,
  Sparkles,
  MessageCircle,
  ArrowLeft
} from 'lucide-react';
import { OnboardingContext } from '../OnboardingContext';
import { ONBOARDING_STEPS, STEP_ORDER } from '../onboardingSteps';
import ProgressBadge from './ProgressBadge';

// Deep explanations from Yana (friendly AI assistant)
const STEP_EXPLANATIONS = {
  welcome: {
    assistant: 'Yana',
    avatar: '👩‍💼',
    greeting: "Hi there! I'm Yana, your GrantFlow guide.",
    explanation: "Welcome to GrantFlow! This is your AI-powered command center for finding and winning grants. Whether you're a student seeking scholarships, a nonprofit looking for funding, or an individual needing assistance, I'm here to help you navigate every step of the journey.",
    tips: [
      "Take your time exploring - there's no rush!",
      "You can always come back to this guide anytime",
      "Don't hesitate to ask questions along the way"
    ]
  },
  add_first_profile: {
    assistant: 'Anya',
    avatar: '👩‍🔬',
    greeting: "Hey! Anya here - let's build your profile!",
    explanation: "Your profile is the foundation of everything in GrantFlow. The more complete your profile, the better I can match you with relevant funding opportunities. Think of it as teaching me about you so I can be your best advocate.",
    tips: [
      "Include all demographics that apply - many grants target specific groups",
      "Don't skip the narrative sections - they help AI understand your unique story",
      "You can always update your profile later as things change"
    ]
  },
  profile_created: {
    assistant: 'Yana',
    avatar: '👩‍💼',
    greeting: "Congratulations! Your profile is ready!",
    explanation: "Excellent work! Now that your profile exists, GrantFlow's AI engines can start analyzing thousands of funding opportunities to find ones that match your unique situation. The more details you add over time, the smarter your matches become.",
    tips: [
      "Check your profile completeness score on the Organizations page",
      "AI can auto-fill missing sections if you enable it",
      "Consider uploading supporting documents for even better matches"
    ]
  },
  upload_documents: {
    assistant: 'Anya',
    avatar: '👩‍🔬',
    greeting: "Let's power up your profile with documents!",
    explanation: "Documents like transcripts, tax returns, IRS determination letters, and resumes give me concrete data to work with. I can extract key information automatically and use it to strengthen your grant applications.",
    tips: [
      "Upload your most recent documents - they're more relevant",
      "PDF format works best for text extraction",
      "Sensitive documents are encrypted and only you can access them"
    ]
  },
  discover_grants_tour: {
    assistant: 'Yana',
    avatar: '👩‍💼',
    greeting: "Time to find your perfect funding matches!",
    explanation: "The Discover Grants page is where the magic happens. Choose a search method - AI Smart Match for personalized results, Quick Search for speed, or Comprehensive Match for deep analysis. I'll scan thousands of opportunities and rank them by how well they fit your profile.",
    tips: [
      "AI Smart Match learns from your history for better results over time",
      "Use filters to narrow down by deadline, amount, or focus area",
      "Save searches you like to run them again later"
    ]
  },
  pipeline_tour: {
    assistant: 'Anya',
    avatar: '👩‍🔬',
    greeting: "Your grants organized, your way!",
    explanation: "The Pipeline is your grant management headquarters. Every opportunity moves through stages: Discovered → Interested → Drafting → Submitted → Awarded. I'll help you track deadlines, auto-advance grants based on activity, and never let anything slip through the cracks.",
    tips: [
      "Drag and drop grants between columns to update status",
      "Click any grant card for full details and AI analysis",
      "Enable auto-advance to let AI move grants automatically"
    ]
  },
  matching_tour: {
    assistant: 'Yana',
    avatar: '👩‍💼',
    greeting: "Let's decode your match scores!",
    explanation: "Every grant gets a match score (0-100%) based on how well it fits your profile. I analyze eligibility requirements, geographic restrictions, focus areas, demographic targeting, and more. Higher scores mean better fit - but always review the details!",
    tips: [
      "Scores above 70% are usually strong matches",
      "Click 'Match Reasons' to see exactly why a grant scored high or low",
      "Low scores don't mean you can't apply - they're just guidance"
    ]
  },
  ai_features_tour: {
    assistant: 'Anya',
    avatar: '👩‍🔬',
    greeting: "Unlock the full power of AI!",
    explanation: "GrantFlow has AI woven throughout: NOFO Parser extracts requirements from funding announcements, AI Grant Scorer evaluates your fit, Proposal Writer helps draft compelling narratives, and Automation handles repetitive tasks so you can focus on winning.",
    tips: [
      "Try the NOFO Parser with any grant announcement URL",
      "Use AI Grant Scorer before investing time in an application",
      "Enable automation in settings for hands-off pipeline management"
    ]
  },
  reports_tour: {
    assistant: 'Yana',
    avatar: '👩‍💼',
    greeting: "Data-driven grant success!",
    explanation: "Reports give you insights into your grant journey: success rates, pipeline velocity, funding by source, and trends over time. Use this data to improve your strategy and demonstrate impact to stakeholders.",
    tips: [
      "Export reports as PDF for board meetings or presentations",
      "Track which funders you're most successful with",
      "Use analytics to identify bottlenecks in your process"
    ]
  },
  complete: {
    assistant: 'Anya',
    avatar: '👩‍🔬',
    greeting: "You're officially a GrantFlow pro! 🎉",
    explanation: "You've completed the full onboarding! You now know how to create profiles, discover grants, manage your pipeline, and leverage AI features. Remember, Yana and I are always here if you need guidance - just open this panel anytime.",
    tips: [
      "Explore features at your own pace",
      "Check back regularly for new AI capabilities",
      "Good luck with your grant applications!"
    ]
  }
};

export default function ChecklistPanel() {
  const context = useContext(OnboardingContext);
  const [selectedStep, setSelectedStep] = useState(null);
  
  // If not in provider, don't render
  if (!context) {
    return null;
  }
  
  const { 
    showChecklist = false, 
    setShowChecklist, 
    completedSteps = [], 
    progressPercent = 0,
    nextStep,
    startTour,
    isComplete = false
  } = context;

  if (!showChecklist) return null;

  const handleStartStep = (step) => {
    if (step?.type === 'tour') {
      startTour?.(step.id);
      setShowChecklist?.(false);
    }
  };
  
  const handleStepClick = (stepId) => {
    setSelectedStep(stepId);
  };
  
  const explanation = selectedStep ? STEP_EXPLANATIONS[selectedStep] : null;
  const safeCompletedSteps = Array.isArray(completedSteps) ? completedSteps : [];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 400, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 400, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed right-0 top-0 h-full w-96 bg-white shadow-2xl z-[80] flex flex-col"
      >
        {/* Header */}
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-900">Setup Guide</h2>
            <button
              onClick={() => setShowChecklist?.(false)}
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Progress */}
          <div className="flex items-center gap-4">
            <ProgressBadge size="lg" />
            <div className="flex-1">
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPercent || 0}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                />
              </div>
              <p className="text-sm text-slate-500 mt-1">
                {safeCompletedSteps.length} of {STEP_ORDER.length} steps complete
              </p>
            </div>
          </div>
        </div>

        {/* Steps list or Detail view */}
        <div className="flex-1 overflow-y-auto p-4">
          <AnimatePresence mode="wait">
            {selectedStep && explanation ? (
              <motion.div
                key="detail"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                {/* Back button */}
                <button
                  onClick={() => setSelectedStep(null)}
                  className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to all steps
                </button>
                
                {/* Assistant card */}
                <div className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-xl p-5 border border-purple-100">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl">
                      {explanation.avatar}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900">{explanation.assistant}</p>
                      <p className="text-sm text-purple-600">AI Assistant</p>
                    </div>
                  </div>
                  
                  <div className="bg-white rounded-lg p-4 shadow-sm mb-4">
                    <p className="text-purple-700 font-medium mb-2">
                      "{explanation.greeting}"
                    </p>
                    <p className="text-slate-600 text-sm leading-relaxed">
                      {explanation.explanation}
                    </p>
                  </div>
                  
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      Pro Tips from {explanation.assistant}
                    </p>
                    {(explanation.tips || []).map((tip, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm text-slate-600">
                        <Sparkles className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
                        <span>{tip}</span>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Action button */}
                {ONBOARDING_STEPS[selectedStep]?.type === 'tour' && !safeCompletedSteps.includes(selectedStep) && (
                  <Button
                    onClick={() => handleStartStep(ONBOARDING_STEPS[selectedStep])}
                    className="w-full bg-purple-600 hover:bg-purple-700"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Start This Tour
                  </Button>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-2"
              >
                {STEP_ORDER.map((stepId, index) => {
                  const step = ONBOARDING_STEPS[stepId];
                  if (!step) return null; // Safety check for undefined steps
                  const isCompleted = safeCompletedSteps.includes(stepId);
                  const isNext = nextStep?.id === stepId;

                  return (
                    <motion.div
                      key={stepId}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      onClick={() => handleStepClick(stepId)}
                      className={`
                        p-4 rounded-xl border transition-all cursor-pointer
                        ${isCompleted 
                          ? 'bg-green-50 border-green-200 hover:border-green-300' 
                          : isNext 
                            ? 'bg-blue-50 border-blue-200 shadow-sm hover:border-blue-300' 
                            : 'bg-white border-slate-100 hover:border-slate-300 hover:shadow-sm'
                        }
                      `}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          {isCompleted ? (
                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                          ) : isNext ? (
                            <motion.div
                              animate={{ scale: [1, 1.2, 1] }}
                              transition={{ duration: 2, repeat: Infinity }}
                            >
                              <Sparkles className="w-5 h-5 text-blue-500" />
                            </motion.div>
                          ) : (
                            <Circle className="w-5 h-5 text-slate-300" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className={`font-medium ${isCompleted ? 'text-green-700' : 'text-slate-900'}`}>
                            {step.title || 'Step'}
                          </h3>
                          <p className="text-sm text-slate-500 mt-0.5">
                            {step.description || ''}
                          </p>
                          <div className="flex items-center gap-4 mt-2">
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {step.estimatedTime || '1 min'}
                            </span>
                            <span className="text-xs text-purple-500 flex items-center gap-1">
                              <MessageCircle className="w-3 h-3" />
                              Click for details
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="w-5 h-5 text-slate-300" />
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50">
          {isComplete ? (
            <div className="text-center py-2">
              <p className="text-green-600 font-medium">🎉 All steps completed!</p>
            </div>
          ) : nextStep ? (
            <Button
              onClick={() => handleStartStep(nextStep)}
              className="w-full bg-blue-600 hover:bg-blue-700"
              disabled={nextStep.type !== 'tour'}
            >
              Continue: {nextStep.title || 'Next Step'}
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}