import React from 'react';
import { CheckCircle2, Circle } from 'lucide-react';

/**
 * Wizard Progress Indicator
 * Shows completed, current, and upcoming steps
 */
export default function WizardProgress({ steps, currentStep, onStepClick }) {
  return (
    <div className="flex items-center justify-between">
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          <button
            onClick={() => index <= currentStep && onStepClick(index)}
            disabled={index > currentStep}
            className={`flex flex-col items-center gap-2 flex-1 transition-all ${
              index > currentStep ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-80'
            }`}
          >
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold ${
              index < currentStep
                ? 'bg-green-500 text-white'
                : index === currentStep
                ? 'bg-blue-600 text-white ring-4 ring-blue-200'
                : 'bg-slate-200 text-slate-500'
            }`}>
              {index < currentStep ? (
                <CheckCircle2 className="w-6 h-6" />
              ) : (
                <span>{index + 1}</span>
              )}
            </div>
            <div className="text-center">
              <p className={`text-xs font-medium ${
                index === currentStep ? 'text-blue-600' : 'text-slate-600'
              }`}>
                {step.title}
              </p>
            </div>
          </button>
          
          {index < steps.length - 1 && (
            <div className={`flex-1 h-1 mx-2 ${
              index < currentStep ? 'bg-green-500' : 'bg-slate-200'
            }`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}