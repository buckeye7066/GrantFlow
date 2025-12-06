import React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Upload, Bot, CheckCircle2 } from 'lucide-react';

/**
 * ProcessingSteps - Multi-step processing indicator
 * @param {Object} props
 * @param {'idle'|'uploading'|'processing'|'complete'|'error'} props.status - Current processing status
 * @param {string} props.errorMessage - Error message if status is 'error'
 */
export default function ProcessingSteps({ status = 'idle', errorMessage = '' }) {
  const steps = [
    {
      id: 'uploading',
      label: 'Uploading File',
      icon: Upload,
      description: 'Uploading your application form...',
      estimate: '~5 seconds'
    },
    {
      id: 'processing',
      label: 'AI Analysis',
      icon: Bot,
      description: 'AI is extracting information from your form',
      estimate: '~30-60 seconds'
    },
    {
      id: 'complete',
      label: 'Complete',
      icon: CheckCircle2,
      description: 'Processing complete!',
      estimate: ''
    }
  ];

  if (status === 'idle') return null;

  const getCurrentStep = () => {
    if (status === 'uploading') return 0;
    if (status === 'processing') return 1;
    if (status === 'complete' || status === 'error') return 2;
    return 0;
  };

  const currentStepIndex = getCurrentStep();

  if (status === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <strong>Processing Failed:</strong>
          <br />
          {errorMessage || 'An unexpected error occurred. Please try again.'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className={
      status === 'complete' 
        ? 'bg-green-50 border-green-200' 
        : 'bg-purple-50 border-purple-200'
    }>
      <AlertDescription>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-500 ${
                  status === 'complete' ? 'bg-green-500' : 'bg-purple-500'
                }`}
                style={{ 
                  width: `${((currentStepIndex + 1) / steps.length) * 100}%` 
                }}
              />
            </div>
            <span className="text-sm font-medium text-slate-700">
              {currentStepIndex + 1}/{steps.length}
            </span>
          </div>

          {steps.map((step, index) => {
            const Icon = step.icon;
            const isActive = index === currentStepIndex;
            const isComplete = index < currentStepIndex;
            
            if (!isActive && !isComplete) return null;

            return (
              <div 
                key={step.id}
                className={`flex items-start gap-3 ${isActive ? 'animate-pulse' : ''}`}
              >
                {isComplete ? (
                  <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                ) : (
                  <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${
                    status === 'complete' ? 'text-green-600' : 'text-purple-600'
                  }`} />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <strong className={
                      status === 'complete' ? 'text-green-900' : 'text-purple-900'
                    }>
                      {step.label}
                    </strong>
                    {isActive && status !== 'complete' && (
                      <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                    )}
                  </div>
                  <p className={`text-sm mt-1 ${
                    status === 'complete' ? 'text-green-800' : 'text-purple-800'
                  }`}>
                    {step.description}
                  </p>
                  {isActive && step.estimate && status !== 'complete' && (
                    <p className="text-xs text-purple-600 mt-1">
                      Estimated time: {step.estimate}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </AlertDescription>
    </Alert>
  );
}