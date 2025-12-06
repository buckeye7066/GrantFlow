import React, { useEffect, useState, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { 
  PartyPopper, 
  Rocket, 
  Search, 
  Users, 
  FileText,
  X,
  Award
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { OnboardingContext } from '../OnboardingContext';

// Simple confetti component
function Confetti() {
  const [particles, setParticles] = useState([]);

  useEffect(() => {
    const colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#10B981', '#F59E0B', '#EF4444'];
    const newParticles = [];
    
    for (let i = 0; i < 50; i++) {
      newParticles.push({
        id: i,
        x: Math.random() * window.innerWidth,
        y: -20,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        size: Math.random() * 8 + 4,
        velocity: Math.random() * 3 + 2,
        wobble: Math.random() * 10 - 5
      });
    }
    setParticles(newParticles);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-[110]">
      {particles.map((particle) => (
        <motion.div
          key={particle.id}
          className="absolute"
          initial={{
            x: particle.x,
            y: particle.y,
            rotate: particle.rotation,
            opacity: 1
          }}
          animate={{
            y: window.innerHeight + 50,
            x: particle.x + particle.wobble * 20,
            rotate: particle.rotation + 360,
            opacity: [1, 1, 0]
          }}
          transition={{
            duration: particle.velocity,
            ease: 'linear'
          }}
          style={{
            width: particle.size,
            height: particle.size * 0.6,
            backgroundColor: particle.color,
            borderRadius: 2
          }}
        />
      ))}
    </div>
  );
}

export default function CompletionCelebration() {
  const context = useContext(OnboardingContext);
  const navigate = useNavigate();
  const [showConfetti, setShowConfetti] = useState(false);
  
  // Safe defaults if not in provider
  const showCelebration = context?.showCelebration ?? false;
  const setShowCelebration = context?.setShowCelebration ?? (() => {});

  useEffect(() => {
    if (showCelebration) {
      setShowConfetti(true);
      const timer = setTimeout(() => setShowConfetti(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [showCelebration]);

  const handleNavigate = (page) => {
    setShowCelebration(false);
    navigate(createPageUrl(page));
  };

  if (!showCelebration) return null;

  return (
    <AnimatePresence>
      {showConfetti && <Confetti />}
      
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          transition={{ type: 'spring', bounce: 0.4 }}
          className="bg-white rounded-2xl shadow-2xl p-8 max-w-lg w-full text-center relative overflow-hidden"
        >
          {/* Close button */}
          <button
            onClick={() => setShowCelebration(false)}
            className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Animated icon */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring', bounce: 0.6 }}
            className="mb-6 inline-flex"
          >
            <div className="relative">
              <div className="w-24 h-24 bg-gradient-to-br from-green-400 to-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-green-500/30">
                <Award className="w-12 h-12 text-white" />
              </div>
              <motion.div
                className="absolute -top-2 -right-2"
                animate={{ rotate: [0, 15, -15, 0] }}
                transition={{ duration: 1, repeat: 3 }}
              >
                <PartyPopper className="w-8 h-8 text-yellow-500" />
              </motion.div>
            </div>
          </motion.div>

          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-3xl font-bold text-slate-900 mb-2"
          >
            You're All Set! 🎉
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-slate-600 mb-8"
          >
            Congratulations! You've completed the GrantFlow setup.
            You're now ready to discover and win grants.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6"
          >
            <button
              onClick={() => handleNavigate('DiscoverGrants')}
              className="p-4 rounded-xl bg-blue-50 hover:bg-blue-100 transition-colors group"
            >
              <Search className="w-8 h-8 text-blue-600 mx-auto mb-2 group-hover:scale-110 transition-transform" />
              <span className="text-sm font-medium text-blue-900">Discover Grants</span>
            </button>
            <button
              onClick={() => handleNavigate('Organizations')}
              className="p-4 rounded-xl bg-purple-50 hover:bg-purple-100 transition-colors group"
            >
              <Users className="w-8 h-8 text-purple-600 mx-auto mb-2 group-hover:scale-110 transition-transform" />
              <span className="text-sm font-medium text-purple-900">Add Profile</span>
            </button>
            <button
              onClick={() => handleNavigate('Pipeline')}
              className="p-4 rounded-xl bg-green-50 hover:bg-green-100 transition-colors group"
            >
              <FileText className="w-8 h-8 text-green-600 mx-auto mb-2 group-hover:scale-110 transition-transform" />
              <span className="text-sm font-medium text-green-900">View Pipeline</span>
            </button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            <Button
              onClick={() => handleNavigate('Dashboard')}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
            >
              <Rocket className="w-4 h-4 mr-2" />
              Go to Dashboard
            </Button>
          </motion.div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}