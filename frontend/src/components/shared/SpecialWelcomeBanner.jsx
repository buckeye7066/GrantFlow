import React, { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sparkles, X, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function SpecialWelcomeBanner({ user }) {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(`welcome_banner_dismissed_${user?.email}`) === 'true';
  });

  const handleDismiss = () => {
    localStorage.setItem(`welcome_banner_dismissed_${user?.email}`, 'true');
    setDismissed(true);
  };

  // Special welcome messages for specific users
  const SPECIAL_USERS = {
    'rdashermiller@gmail.com': {
      name: 'Rachel',
      message: 'Thank you so much for all your help testing and improving GrantFlow. Your feedback has been invaluable in shaping this platform.',
      tier: 'Impact Enterprise tier'
    },
    'avenell@grantflow.app': {
      name: 'Avenell',
      message: 'Thank you for using GrantFlow! We truly appreciate your trust in our service and are honored to help you on your funding journey.',
      tier: null
    }
  };

  const userConfig = user ? SPECIAL_USERS[user.email] : null;

  // Only show for special users
  if (!user || !userConfig || dismissed) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="mb-6"
      >
        <Alert className="bg-gradient-to-r from-purple-50 via-pink-50 to-blue-50 border-2 border-purple-300">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <Sparkles className="w-6 h-6 text-purple-600 mt-1" />
              <div>
                <AlertDescription className="text-slate-900">
                  <p className="text-lg font-bold mb-2 text-purple-900">
                    Welcome, {userConfig.name}! 🎉
                  </p>
                  <p className="mb-2">
                    {userConfig.message}
                  </p>
                  {userConfig.tier && (
                    <p className="mb-2">
                      You've been upgraded to <span className="font-bold text-purple-700">{userConfig.tier}</span> with 
                      unlimited access to all features as a token of appreciation.
                    </p>
                  )}
                  <p className="flex items-center gap-2 text-sm text-slate-700 mt-3">
                    <Heart className="w-4 h-4 text-red-500 fill-red-500" />
                    We deeply appreciate you being part of the GrantFlow community.
                  </p>
                </AlertDescription>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDismiss}
              className="shrink-0"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </Alert>
      </motion.div>
    </AnimatePresence>
  );
}