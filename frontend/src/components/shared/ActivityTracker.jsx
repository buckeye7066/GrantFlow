import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { base44 } from '@/api/base44Client';

let sessionId = null;

// Generate session ID once per browser session
if (typeof window !== 'undefined') {
  sessionId = sessionStorage.getItem('activity_session_id');
  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem('activity_session_id', sessionId);
  }
}

export default function ActivityTracker({ user, currentPageName }) {
  const location = useLocation();

  useEffect(() => {
    if (!user?.email) return;

    const trackActivity = async () => {
      try {
        await base44.entities.UserActivity.create({
          user_email: user.email,
          user_name: user.full_name || user.email,
          activity_type: 'page_visit',
          page_name: currentPageName || 'Unknown',
          page_url: location.pathname,
          session_id: sessionId,
          user_agent: navigator.userAgent
        });
      } catch (error) {
        // Silently fail - don't disrupt user experience
      }
    };

    trackActivity();
  }, [location.pathname, currentPageName, user]);

  return null;
}