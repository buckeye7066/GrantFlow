import React, { useState, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { 
  Sparkles, 
  FileText, 
  Search, 
  TrendingUp, 
  ArrowRight,
  X,
  Zap,
  Target
} from 'lucide-react';
import { OnboardingContext } from '../OnboardingContext';
import { ONBOARDING_STEPS, STEP_ORDER } from '../onboardingSteps';

const FEATURES = [
  {
    icon: Search,
    title: 'AI-Powered Discovery',
    description: 'Find grants that match your unique profile',
    color: 'from-blue-500 to-cyan-500'
  },
  {
    icon: Target,
    title: 'Smart Matching',
    description: 'Get ranked opportunities with match scores',
    color: 'from-purple-500 to-pink-500'
  },
  {
    icon: FileText,
    title: 'Application Builder',
    description: 'Create winning proposals with AI assistance',
    color: 'from-orange-500 to-red-500'
  },
  {
    icon: TrendingUp,
    title: 'Pipeline Management',
    description: 'Track every grant from discovery to award',
    color: 'from-green-500 to-emerald-500'
  }
];

export default function AnimatedIntroScreen() {
  const context = useContext(OnboardingContext);
  const [currentPage, setCurrentPage] = useState(0);
  const [isExiting, setIsExiting] = useState(false);
  
  // If not in provider, don't render
  if (!context) {
    return null;
  }
  
  const { setShowIntro, completeStep, skipOnboarding } = context;

  const handleStart = async () => {
    setIsExiting(true);
    try {
      await completeStep?.('welcome');
    } catch (e) {
      console.warn('[AnimatedIntroScreen] Could not complete step:', e);
    }
    setTimeout(() => setShowIntro?.(false), 300);
  };

  const handleSkip = async () => {
    setIsExiting(true);
    try {
      await skipOnboarding?.();
    } catch (e) {
      console.warn('[AnimatedIntroScreen] Could not skip:', e);
    }
    setTimeout(() => setShowIntro?.(false), 300);
  };

  // Safe window dimensions for SSR
  const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
  const windowHeight = typeof window !== 'undefined' ? window.innerHeight : 800;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isExiting ? 0 : 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-gradient-to-br from-slate-900 via-blue-900 to-purple-900"
      >
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden">
          {[...Array(20)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute w-2 h-2 bg-white/10 rounded-full"
              initial={{
                x: Math.random() * windowWidth,
                y: Math.random() * windowHeight,
                scale: Math.random() * 0.5 + 0.5
              }}
              animate={{
                y: [null, Math.random() * -200 - 100],
                opacity: [0, 1, 0]
              }}
              transition={{
                duration: Math.random() * 3 + 2,
                repeat: Infinity,
                repeatDelay: Math.random() * 2
              }}
            />
          ))}
        </div>

        {/* Skip button */}
        <button
          onClick={handleSkip}
          className="absolute top-6 right-6 p-2 text-white/60 hover:text-white transition-colors"
        >
          <X className="w-6 h-6" />
        </button>

        {/* Main content */}
        <div className="relative max-w-4xl w-full">
          <AnimatePresence mode="wait">
            {currentPage === 0 && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-center"
              >
                {/* Logo animation */}
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', bounce: 0.5, delay: 0.2 }}
                  className="mb-8 inline-flex"
                >
                  <div className="relative">
                    <div className="w-24 h-24 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-500/30">
                      <FileText className="w-12 h-12 text-white" />
                    </div>
                    <motion.div
                      className="absolute -top-2 -right-2"
                      animate={{ rotate: [0, 10, -10, 0] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <Sparkles className="w-8 h-8 text-yellow-400" />
                    </motion.div>
                  </div>
                </motion.div>

                <motion.h1
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="text-5xl md:text-6xl font-bold text-white mb-4"
                >
                  Welcome to{' '}
                  <span className="bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                    GrantFlow
                  </span>
                </motion.h1>

                <motion.p
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                  className="text-xl text-blue-100/80 mb-12 max-w-2xl mx-auto"
                >
                  Your AI-powered platform for discovering, managing, and winning grants
                </motion.p>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6 }}
                  className="flex flex-col sm:flex-row gap-4 justify-center"
                >
                  <Button
                    onClick={() => setCurrentPage(1)}
                    size="lg"
                    className="bg-white text-blue-900 hover:bg-blue-50 px-8 py-6 text-lg font-semibold shadow-xl"
                  >
                    Let's Get Started
                    <ArrowRight className="ml-2 w-5 h-5" />
                  </Button>
                  <Button
                    onClick={handleSkip}
                    variant="ghost"
                    size="lg"
                    className="text-white/70 hover:text-white hover:bg-white/10"
                  >
                    Skip for now
                  </Button>
                </motion.div>
              </motion.div>
            )}

            {currentPage === 1 && (
              <motion.div
                key="features"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <h2 className="text-3xl font-bold text-white text-center mb-2">
                  What You Can Do
                </h2>
                <p className="text-blue-100/70 text-center mb-8">
                  Powerful tools to streamline your grant journey
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                  {FEATURES.map((feature, index) => (
                    <motion.div
                      key={feature.title}
                      initial={{ opacity: 0, x: index % 2 === 0 ? -20 : 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20"
                    >
                      <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${feature.color} flex items-center justify-center mb-4`}>
                        <feature.icon className="w-6 h-6 text-white" />
                      </div>
                      <h3 className="text-lg font-semibold text-white mb-2">
                        {feature.title}
                      </h3>
                      <p className="text-blue-100/70 text-sm">
                        {feature.description}
                      </p>
                    </motion.div>
                  ))}
                </div>

                <div className="flex gap-4 justify-center">
                  <Button
                    onClick={() => setCurrentPage(0)}
                    variant="ghost"
                    className="text-white/70 hover:text-white hover:bg-white/10"
                  >
                    Back
                  </Button>
                  <Button
                    onClick={() => setCurrentPage(2)}
                    size="lg"
                    className="bg-white text-blue-900 hover:bg-blue-50 px-8"
                  >
                    Next
                    <ArrowRight className="ml-2 w-5 h-5" />
                  </Button>
                </div>
              </motion.div>
            )}

            {currentPage === 2 && (
              <motion.div
                key="steps"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <h2 className="text-3xl font-bold text-white text-center mb-2">
                  Your Setup Journey
                </h2>
                <p className="text-blue-100/70 text-center mb-8">
                  We'll guide you through each step
                </p>

                <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/20 mb-8">
                  <div className="space-y-4">
                    {STEP_ORDER.slice(1, 6).map((stepId, index) => {
                      const step = ONBOARDING_STEPS[stepId];
                      if (!step) return null; // Safety check
                      return (
                        <motion.div
                          key={stepId}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: index * 0.1 }}
                          className="flex items-center gap-4"
                        >
                          <div className="w-8 h-8 rounded-full bg-blue-500/30 flex items-center justify-center text-white font-semibold">
                            {index + 1}
                          </div>
                          <div className="flex-1">
                            <h4 className="text-white font-medium">{step.title || 'Step'}</h4>
                            <p className="text-blue-100/60 text-sm">{step.description || ''}</p>
                          </div>
                          <span className="text-blue-100/50 text-sm">
                            ~{step.estimatedTime || '1 min'}
                          </span>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex gap-4 justify-center">
                  <Button
                    onClick={() => setCurrentPage(1)}
                    variant="ghost"
                    className="text-white/70 hover:text-white hover:bg-white/10"
                  >
                    Back
                  </Button>
                  <Button
                    onClick={handleStart}
                    size="lg"
                    className="bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white px-8 shadow-xl"
                  >
                    <Zap className="mr-2 w-5 h-5" />
                    Start Setup
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Page indicators */}
          <div className="flex justify-center gap-2 mt-8">
            {[0, 1, 2].map((page) => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={`w-2 h-2 rounded-full transition-all ${
                  currentPage === page
                    ? 'bg-white w-8'
                    : 'bg-white/30 hover:bg-white/50'
                }`}
              />
            ))}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}