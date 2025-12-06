import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import WelcomeMessageModal from './WelcomeMessageModal';

export default function WelcomeMessageHandler({ user }) {
  const [showMessage, setShowMessage] = useState(false);
  const [currentMessage, setCurrentMessage] = useState(null);
  const queryClient = useQueryClient();

  // Fetch unread welcome messages for this user
  const { data: welcomeMessages = [] } = useQuery({
    queryKey: ['welcomeMessages', user?.email],
    queryFn: async () => {
      if (!user?.email) return [];
      try {
        const messages = await base44.entities.WelcomeMessage.filter({
          user_email: user.email,
          sent: false,
          dismissed: false
        });
        return messages;
      } catch (error) {
        console.log('[WelcomeMessageHandler] Error fetching messages:', error);
        return [];
      }
    },
    enabled: !!user?.email,
    refetchOnWindowFocus: false,
  });

  // Mark message as sent/dismissed
  const dismissMutation = useMutation({
    mutationFn: async (messageId) => {
      await base44.entities.WelcomeMessage.update(messageId, {
        sent: true,
        dismissed: true,
        sent_date: new Date().toISOString()
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['welcomeMessages']);
    }
  });

  // Show first unread message when available
  useEffect(() => {
    if (welcomeMessages.length > 0 && !currentMessage) {
      setCurrentMessage(welcomeMessages[0]);
      setShowMessage(true);
    }
  }, [welcomeMessages, currentMessage]);

  const handleDismiss = async () => {
    if (currentMessage?.id) {
      await dismissMutation.mutateAsync(currentMessage.id);
    }
    setShowMessage(false);
    setCurrentMessage(null);
  };

  if (!user || !currentMessage) return null;

  return (
    <WelcomeMessageModal
      message={currentMessage}
      isOpen={showMessage}
      onDismiss={handleDismiss}
    />
  );
}