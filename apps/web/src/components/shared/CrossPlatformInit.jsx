/**
 * Cross-Platform Initialization Component
 * 
 * Initializes PWA, localStorage fallback, and service worker
 * Include once in Layout or App root
 */

import { useEffect } from "react";
import { initLocalStorageFallback, registerServiceWorker } from "./safeNavigate";

export default function CrossPlatformInit() {
  useEffect(() => {
    // Initialize localStorage fallback for restricted browsers (iOS Messenger, etc.)
    initLocalStorageFallback();
    
    // Register service worker for PWA support
    registerServiceWorker();
    
    // Log platform info for debugging
    const ua = navigator.userAgent || "";
    const isInApp = /FBAN|FBAV|Instagram|Messenger|Line|TikTok|Snapchat|WebView|wv\)/i.test(ua);
    const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    
    console.log("[CrossPlatform] Initialized", {
      isInAppBrowser: isInApp,
      isPWA,
      userAgent: ua.substring(0, 100)
    });
  }, []);

  // Render nothing - this is just for side effects
  return null;
}