import React, { useRef, useEffect, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * PHIDocumentUploader - Upload and process PHI documents with defensive callback handling
 * 
 * Features:
 * - Ref-based callback tracking to ensure latest callbacks are used
 * - Safe callback invocation with error handling and logging
 * - CustomEvent fallback when no handlers are provided
 * - Inline error UI when handler is missing and fallback not handled
 */

const PHIDocumentUploader = ({
  onUpdate,
  confirmAndSave,
  onSave,
  onComplete,
  onError,
  onCancel,
  children
}) => {
  // Use refs to track latest callback props
  const onUpdateRef = useRef(onUpdate);
  const confirmAndSaveRef = useRef(confirmAndSave);
  const onSaveRef = useRef(onSave);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  const onCancelRef = useRef(onCancel);

  const [handlerError, setHandlerError] = useState(null);

  // Update refs when props change
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    confirmAndSaveRef.current = confirmAndSave;
  }, [confirmAndSave]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  /**
   * Safely invoke a callback ref with error handling
   * @param {Object} ref - The ref containing the callback
   * @param {string} name - Name of the callback for logging
   * @param  {...any} args - Arguments to pass to the callback
   * @returns {Promise<boolean>} - True if callback was invoked successfully
   */
  const safeInvokeRef = async (ref, name, ...args) => {
    const fn = ref.current;

    if (typeof fn !== 'function') {
      console.warn(`[PHIDocumentUploader] ${name} callback missing - skipping profile update`);
      return false;
    }

    try {
      const result = fn(...args);
      
      // Handle promises
      if (result && typeof result.then === 'function') {
        await result;
      }

      return true;
    } catch (error) {
      console.error(`[PHIDocumentUploader] Error in ${name} callback:`, error);
      
      // Invoke error handler if available
      if (onErrorRef.current && typeof onErrorRef.current === 'function') {
        try {
          onErrorRef.current(error);
        } catch (errHandlerError) {
          console.error('[PHIDocumentUploader] Error in error handler:', errHandlerError);
        }
      }
      
      return false;
    }
  };

  /**
   * Handle PHI data extraction and dispatch update
   * @param {Object} extractedData - The extracted PHI data
   */
  const handlePHIUpdate = async (extractedData) => {
    setHandlerError(null);

    // Try to invoke onUpdate callback first
    const onUpdateInvoked = await safeInvokeRef(onUpdateRef, 'onUpdate', extractedData);
    
    if (onUpdateInvoked) {
      return;
    }

    // Try confirmAndSave as fallback
    const confirmAndSaveInvoked = await safeInvokeRef(confirmAndSaveRef, 'confirmAndSave', extractedData);
    
    if (confirmAndSaveInvoked) {
      return;
    }

    // No handlers available, dispatch CustomEvent as fallback
    const event = new CustomEvent('GrantFlow:profile-update-request', {
      detail: { payload: extractedData },
      bubbles: true,
      cancelable: true
    });

    document.dispatchEvent(event);

    // Check if event was handled
    if (event.defaultPrevented) {
      console.log('[PHIDocumentUploader] Profile update handled by event listener');
      return;
    }

    // No handler and fallback not handled - show inline error
    console.error('[PHIDocumentUploader] No handler available for profile update');
    setHandlerError('Unable to save profile updates. Please ensure a handler is configured.');
  };

  /**
   * Handle save action
   */
  const handleSave = async () => {
    setHandlerError(null);
    const saved = await safeInvokeRef(onSaveRef, 'onSave');
    
    if (!saved) {
      setHandlerError('Save handler not available');
    }
  };

  /**
   * Handle complete action
   */
  const handleComplete = async () => {
    await safeInvokeRef(onCompleteRef, 'onComplete');
  };

  /**
   * Handle cancel action
   */
  const handleCancel = async () => {
    await safeInvokeRef(onCancelRef, 'onCancel');
  };

  // Expose methods via ref if needed
  const uploaderApi = {
    handlePHIUpdate,
    handleSave,
    handleComplete,
    handleCancel
  };

  return (
    <div className="phi-document-uploader">
      {handlerError && (
        <div className="phi-uploader-error" style={{
          padding: '12px',
          marginBottom: '12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          borderRadius: '4px',
          color: '#c33'
        }}>
          {handlerError}
        </div>
      )}
      
      {typeof children === 'function' ? children(uploaderApi) : children}
    </div>
  );
};

PHIDocumentUploader.propTypes = {
  onUpdate: PropTypes.func,
  confirmAndSave: PropTypes.func,
  onSave: PropTypes.func,
  onComplete: PropTypes.func,
  onError: PropTypes.func,
  onCancel: PropTypes.func,
  children: PropTypes.oneOfType([PropTypes.node, PropTypes.func])
};

PHIDocumentUploader.defaultProps = {
  onUpdate: null,
  confirmAndSave: null,
  onSave: null,
  onComplete: null,
  onError: null,
  onCancel: null,
  children: null
};

export default PHIDocumentUploader;
