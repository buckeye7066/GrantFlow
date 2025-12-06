import React, { useContext } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  GraduationCap, 
  Play, 
  RotateCcw, 
  BookOpen, 
  HelpCircle,
  CheckCircle2
} from 'lucide-react';
import { OnboardingContext } from './OnboardingContext';
import ProgressBadge from './ui/ProgressBadge';

export default function OnboardingMenuButton() {
  const context = useContext(OnboardingContext);
  
  // If not in provider, don't render anything
  if (!context) {
    return null;
  }
  
  const { 
    progressPercent = 0, 
    isDismissed = false, 
    isComplete = false,
    resumeOnboarding, 
    restartOnboarding,
    setShowChecklist
  } = context;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-slate-600 hover:text-slate-900"
        >
          <GraduationCap className="w-4 h-4" />
          <span className="hidden sm:inline">Tutorial</span>
          {!isComplete && progressPercent > 0 && (
            <ProgressBadge size="sm" showPercent={false} />
          )}
          {isComplete && (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-3 py-2">
          <p className="text-sm font-medium text-slate-900">Onboarding</p>
          <p className="text-xs text-slate-500">
            {isComplete ? 'Completed!' : `${progressPercent}% complete`}
          </p>
        </div>
        <DropdownMenuSeparator />
        
        {isDismissed ? (
          <DropdownMenuItem onClick={resumeOnboarding}>
            <Play className="w-4 h-4 mr-2" />
            Resume Onboarding
          </DropdownMenuItem>
        ) : !isComplete ? (
          <DropdownMenuItem onClick={() => setShowChecklist(true)}>
            <BookOpen className="w-4 h-4 mr-2" />
            View Progress
          </DropdownMenuItem>
        ) : null}
        
        <DropdownMenuItem onClick={restartOnboarding}>
          <RotateCcw className="w-4 h-4 mr-2" />
          Restart Full Onboarding
        </DropdownMenuItem>
        
        <DropdownMenuSeparator />
        
        <DropdownMenuItem onClick={() => setShowChecklist(true)}>
          <HelpCircle className="w-4 h-4 mr-2" />
          View All Tutorials
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}