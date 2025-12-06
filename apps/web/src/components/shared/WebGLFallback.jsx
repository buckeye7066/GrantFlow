/**
 * WebGL Fallback Component
 * 
 * Provides graceful degradation for 3D components
 * when WebGL is not available (in-app browsers, older devices)
 */

import React, { useState, useEffect } from "react";
import { isWebGLAvailable } from "./safeNavigate";
import { Atom, Box } from "lucide-react";

/**
 * HOC that wraps 3D components with WebGL detection
 * @param {React.Component} Component - The 3D component to wrap
 * @param {string} fallbackType - Type of fallback: 'molecule', 'dna', 'generic'
 */
export function withWebGLFallback(Component, fallbackType = 'generic') {
  return function WebGLWrappedComponent(props) {
    const [webGLAvailable, setWebGLAvailable] = useState(true);
    const [checked, setChecked] = useState(false);

    useEffect(() => {
      setWebGLAvailable(isWebGLAvailable());
      setChecked(true);
    }, []);

    if (!checked) {
      return (
        <div className="webgl-fallback animate-pulse">
          <div className="text-white/50">Loading...</div>
        </div>
      );
    }

    if (!webGLAvailable) {
      return <WebGLFallbackDisplay type={fallbackType} {...props} />;
    }

    return <Component {...props} />;
  };
}

/**
 * Fallback display when WebGL is unavailable
 */
export function WebGLFallbackDisplay({ type = 'generic', className = '', message }) {
  const icons = {
    molecule: Atom,
    dna: Box,
    generic: Box
  };
  
  const Icon = icons[type] || icons.generic;
  
  const messages = {
    molecule: "3D Molecule Viewer",
    dna: "DNA Visualization",
    generic: "3D Visualization"
  };
  
  const displayMessage = message || messages[type] || messages.generic;

  return (
    <div className={`webgl-fallback flex-col gap-4 p-8 ${className}`}>
      <div className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center">
        <Icon className="w-10 h-10 text-white" />
      </div>
      <div className="text-center">
        <p className="text-white font-medium">{displayMessage}</p>
        <p className="text-white/70 text-sm mt-1">
          3D view not available in this browser
        </p>
        <p className="text-white/50 text-xs mt-2">
          Open in Safari or Chrome for full experience
        </p>
      </div>
    </div>
  );
}

/**
 * Hook for WebGL detection
 */
export function useWebGLAvailable() {
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setAvailable(isWebGLAvailable());
    setLoading(false);
  }, []);

  return { available, loading };
}

export default WebGLFallbackDisplay;