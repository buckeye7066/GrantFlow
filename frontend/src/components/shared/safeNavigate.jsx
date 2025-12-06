/**
 * Cross-Platform Safe Navigation Utility
 * 
 * Handles navigation reliably across:
 * - iOS Safari
 * - iOS in-app browsers (Messenger, Messages, Instagram, TikTok, Facebook)
 * - Android Chrome
 * - Android WebView / embedded browsers
 * - Desktop browsers
 * - Standalone PWA mode
 */

/**
 * Detect if running in an in-app browser
 */
export function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /FBAN|FBAV|Instagram|Messenger|Line|TikTok|Snapchat|WebView|wv\)/i.test(ua);
}

/**
 * Detect if running in iOS
 */
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

/**
 * Detect if running in standalone PWA mode
 */
export function isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

/**
 * Safe internal navigation that works across all platforms
 * @param {string} url - Internal URL to navigate to
 */
export function safeNavigate(url) {
  const ua = navigator.userAgent || "";
  const isInApp = /FBAN|FBAV|Instagram|Messenger|Line|TikTok|Snapchat|WebView|wv\)/i.test(ua);

  if (isInApp) {
    // Direct location change works reliably in restricted browsers
    window.location.href = url;
  } else {
    window.open(url, "_self");
  }
}

/**
 * Safe external link opening that bypasses popup blockers
 * @param {string} url - External URL to open
 */
export function safeOpenExternal(url) {
  // Must be called from a direct user interaction (onClick)
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Safe login redirect for in-app browsers
 * @param {function} defaultLoginFn - Default login function (e.g., base44.auth.redirectToLogin)
 * @param {string} fallbackUrl - Fallback URL if in-app browser detected
 */
export function safeLoginRedirect(defaultLoginFn, fallbackUrl = "/login") {
  const ua = navigator.userAgent || "";
  const isInApp = /FBAN|FBAV|Instagram|Messenger|Line|TikTok|Snapchat|WebView|wv\)/i.test(ua);

  if (isInApp) {
    // In-app browsers block popups, use direct navigation
    window.location.href = fallbackUrl;
  } else if (typeof defaultLoginFn === 'function') {
    defaultLoginFn();
  } else {
    window.location.href = fallbackUrl;
  }
}

/**
 * Check if WebGL is available (for 3D components)
 * @returns {boolean}
 */
export function isWebGLAvailable() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return !!gl;
  } catch (e) {
    return false;
  }
}

/**
 * Initialize localStorage fallback for restricted browsers
 */
export function initLocalStorageFallback() {
  try {
    localStorage.setItem("__test__", "1");
    localStorage.removeItem("__test__");
  } catch (e) {
    console.warn("localStorage disabled — using fallback memory store");
    const store = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        setItem(k, v) { store[k] = String(v); },
        getItem(k) { return store[k] || null; },
        removeItem(k) { delete store[k]; },
        clear() { Object.keys(store).forEach(k => delete store[k]); },
        get length() { return Object.keys(store).length; },
        key(i) { return Object.keys(store)[i] || null; }
      },
      writable: false
    });
  }
}

/**
 * Register service worker for PWA support
 * Note: Only register if the service-worker.js file actually exists
 */
export function registerServiceWorker() {
  // Skip service worker registration in Base44 preview/hosted environment
  // as the service-worker.js file doesn't exist and causes MIME type errors
  if (typeof window !== 'undefined' && window.location.hostname.includes('base44')) {
    return; // Skip registration on Base44 platform
  }
  
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js")
      .then(reg => console.log("[PWA] Service worker registered:", reg.scope))
      .catch(err => console.warn("[PWA] Service worker registration failed:", err));
  }
}

export default {
  safeNavigate,
  safeOpenExternal,
  safeLoginRedirect,
  isInAppBrowser,
  isIOS,
  isPWA,
  isWebGLAvailable,
  initLocalStorageFallback,
  registerServiceWorker
};