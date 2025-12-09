import { useEffect } from 'react';
import ReconnectingWebSocket from './ReconnectingWebSocket';

/**
 * CrossPlatformInit - Initialize cross-platform services with defensive error handling
 * 
 * Features:
 * - Use ReconnectingWebSocket instead of raw WebSocket to avoid noisy errors
 * - Guard fbq (Meta Pixel) initialization to prevent duplicate warnings
 * - Defer non-critical initialization work
 */

let wsInstance = null;
let fbqInitialized = false;

const CrossPlatformInit = ({ wsUrl, metaPixelId, onWebSocketMessage }) => {
  useEffect(() => {
    // Defer non-critical initialization work
    const deferredInit = () => {
      // Initialize Meta Pixel only once to avoid duplicate Pixel ID warnings
      if (metaPixelId && !fbqInitialized && typeof window !== 'undefined' && window.fbq) {
        try {
          window.fbq('init', metaPixelId);
          fbqInitialized = true;
          console.log('[CrossPlatformInit] Meta Pixel initialized');
        } catch (error) {
          console.error('[CrossPlatformInit] Meta Pixel initialization failed:', error);
        }
      }

      // Initialize WebSocket with reconnection support
      if (wsUrl && !wsInstance) {
        try {
          wsInstance = new ReconnectingWebSocket(wsUrl, [], {
            maxReconnectAttempts: 10,
            reconnectInterval: 1000,
            maxReconnectInterval: 30000,
            reconnectDecay: 1.5
          });

          wsInstance.addEventListener('open', () => {
            console.log('[CrossPlatformInit] WebSocket connected');
          });

          wsInstance.addEventListener('message', (event) => {
            try {
              if (onWebSocketMessage && typeof onWebSocketMessage === 'function') {
                onWebSocketMessage(event);
              }
            } catch (error) {
              console.error('[CrossPlatformInit] WebSocket message handler error:', error);
            }
          });

          wsInstance.addEventListener('close', () => {
            console.log('[CrossPlatformInit] WebSocket disconnected');
          });

          wsInstance.addEventListener('error', (error) => {
            // Error already logged by ReconnectingWebSocket, no need for duplicate logs
          });

        } catch (error) {
          console.error('[CrossPlatformInit] WebSocket initialization failed:', error);
        }
      }
    };

    // Use requestIdleCallback if available, otherwise setTimeout
    if (typeof window !== 'undefined') {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(deferredInit, { timeout: 2000 });
      } else {
        setTimeout(deferredInit, 100);
      }
    }

    // Cleanup on unmount
    return () => {
      if (wsInstance) {
        wsInstance.close();
        wsInstance = null;
      }
    };
  }, [wsUrl, metaPixelId, onWebSocketMessage]);

  return null;
};

export default CrossPlatformInit;
