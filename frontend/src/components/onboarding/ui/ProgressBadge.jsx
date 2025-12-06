import React, { useContext } from 'react';
import { motion } from 'framer-motion';
import { OnboardingContext } from '../OnboardingContext';

export default function ProgressBadge({ size = 'md', showPercent = true }) {
  const context = useContext(OnboardingContext);
  
  // Safe defaults if not in provider
  const progressPercent = context?.progressPercent ?? 0;
  const isComplete = context?.isComplete ?? false;

  const sizes = {
    sm: { outer: 32, inner: 24, stroke: 3, text: 'text-xs' },
    md: { outer: 48, inner: 38, stroke: 4, text: 'text-sm' },
    lg: { outer: 64, inner: 52, stroke: 5, text: 'text-base' }
  };

  const { outer, inner, stroke, text } = sizes[size] || sizes.md;
  const radius = (inner - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - ((progressPercent || 0) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: outer, height: outer }}>
      <svg
        width={inner}
        height={inner}
        className="transform -rotate-90"
      >
        {/* Background circle */}
        <circle
          cx={inner / 2}
          cy={inner / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
          fill="none"
          className="text-slate-200"
        />
        {/* Progress circle */}
        <motion.circle
          cx={inner / 2}
          cy={inner / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          className={isComplete ? 'text-green-500' : 'text-blue-500'}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          style={{
            strokeDasharray: circumference
          }}
        />
      </svg>
      {showPercent && (
        <span className={`absolute ${text} font-semibold ${isComplete ? 'text-green-600' : 'text-slate-700'}`}>
          {progressPercent}%
        </span>
      )}
    </div>
  );
}