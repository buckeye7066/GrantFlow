import React, { useState, useEffect, useRef, useContext } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { ArrowRight, ArrowLeft, X, ChevronRight } from 'lucide-react';
import { OnboardingContext } from '../OnboardingContext';
import { PAGE_TOURS } from '../onboardingSteps';

export default function SpotlightHighlighter() {
  const context = useContext(OnboardingContext);
  
  // Safe defaults if not in provider
  const activeTour = context?.activeTour;
  const tourStep = context?.tourStep ?? 0;
  const nextTourStep = context?.nextTourStep ?? (() => {});
  const prevTourStep = context?.prevTourStep ?? (() => {});
  const endTour = context?.endTour ?? (() => {});
  const [targetRect, setTargetRect] = useState(null);
  const [cardPosition, setCardPosition] = useState({ top: 0, left: 0 });
  const observerRef = useRef(null);

  const currentTour = Object.values(PAGE_TOURS).find(t => t.id === activeTour);
  const currentStep = currentTour?.steps?.[tourStep];
  const totalSteps = currentTour?.steps?.length || 0;

  useEffect(() => {
    if (!currentStep?.target) {
      setTargetRect(null);
      return;
    }

    const findAndHighlight = () => {
      const element = document.querySelector(currentStep.target);
      if (element) {
        const rect = element.getBoundingClientRect();
        setTargetRect({
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width,
          height: rect.height
        });

        // Calculate card position
        const padding = 16;
        const cardWidth = 320;
        const cardHeight = 180;
        
        let top = rect.top + window.scrollY;
        let left = rect.left + window.scrollX;

        switch (currentStep.position) {
          case 'bottom':
            top = rect.bottom + window.scrollY + padding;
            left = rect.left + window.scrollX + (rect.width / 2) - (cardWidth / 2);
            break;
          case 'top':
            top = rect.top + window.scrollY - cardHeight - padding;
            left = rect.left + window.scrollX + (rect.width / 2) - (cardWidth / 2);
            break;
          case 'left':
            top = rect.top + window.scrollY + (rect.height / 2) - (cardHeight / 2);
            left = rect.left + window.scrollX - cardWidth - padding;
            break;
          case 'right':
            top = rect.top + window.scrollY + (rect.height / 2) - (cardHeight / 2);
            left = rect.right + window.scrollX + padding;
            break;
          default:
            top = rect.bottom + window.scrollY + padding;
        }

        // Keep within viewport
        const maxLeft = window.innerWidth - cardWidth - padding;
        const maxTop = window.innerHeight + window.scrollY - cardHeight - padding;
        left = Math.max(padding, Math.min(left, maxLeft));
        top = Math.max(padding, Math.min(top, maxTop));

        setCardPosition({ top, left });

        // Scroll element into view if needed
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setTargetRect(null);
      }
    };

    // Initial find
    findAndHighlight();

    // Set up mutation observer for dynamic content
    observerRef.current = new MutationObserver(findAndHighlight);
    observerRef.current.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Listen for scroll/resize
    window.addEventListener('scroll', findAndHighlight);
    window.addEventListener('resize', findAndHighlight);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      window.removeEventListener('scroll', findAndHighlight);
      window.removeEventListener('resize', findAndHighlight);
    };
  }, [currentStep?.target, currentStep?.position]);

  if (!activeTour || !currentStep) return null;

  const overlay = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90]"
        style={{ pointerEvents: 'none' }}
      >
        {/* Dark overlay with spotlight cutout */}
        <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'auto' }}>
          <defs>
            <mask id="spotlight-mask">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {targetRect && (
                <rect
                  x={targetRect.left - 8}
                  y={targetRect.top - 8}
                  width={targetRect.width + 16}
                  height={targetRect.height + 16}
                  rx="8"
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.75)"
            mask="url(#spotlight-mask)"
            onClick={endTour}
          />
        </svg>

        {/* Glowing ring around target */}
        {targetRect && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute pointer-events-none"
            style={{
              top: targetRect.top - 8,
              left: targetRect.left - 8,
              width: targetRect.width + 16,
              height: targetRect.height + 16
            }}
          >
            <div className="absolute inset-0 rounded-lg border-2 border-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.5)]" />
            <motion.div
              className="absolute inset-0 rounded-lg border-2 border-blue-400"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              style={{ opacity: 0.5 }}
            />
          </motion.div>
        )}

        {/* Info card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute bg-white rounded-xl shadow-2xl p-5 w-80 pointer-events-auto"
          style={{
            top: cardPosition.top,
            left: cardPosition.left,
            zIndex: 100
          }}
        >
          {/* Progress indicator */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-1">
              {[...Array(totalSteps)].map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-6 rounded-full transition-colors ${
                    i <= tourStep ? 'bg-blue-500' : 'bg-slate-200'
                  }`}
                />
              ))}
            </div>
            <button
              onClick={endTour}
              className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <h3 className="text-lg font-semibold text-slate-900 mb-2">
            {currentStep.title}
          </h3>
          <p className="text-slate-600 text-sm mb-4">
            {currentStep.description}
          </p>

          <div className="flex items-center justify-between">
            <Button
              onClick={prevTourStep}
              variant="ghost"
              size="sm"
              disabled={tourStep === 0}
              className="text-slate-500"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>

            <span className="text-xs text-slate-400">
              {tourStep + 1} of {totalSteps}
            </span>

            <Button
              onClick={nextTourStep}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700"
            >
              {tourStep === totalSteps - 1 ? 'Finish' : 'Next'}
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(overlay, document.body);
}