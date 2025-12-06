import { useState, useCallback } from 'react';

/**
 * Manages modal state for organization profile
 * Centralizes all modal visibility logic
 * 
 * @returns {Object} Modal states and toggle functions
 */
export function useProfileModals() {
  const [isEmailComposerOpen, setIsEmailComposerOpen] = useState(false);
  const [isHarvesterOpen, setIsHarvesterOpen] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const openEmailComposer = useCallback(() => setIsEmailComposerOpen(true), []);
  const closeEmailComposer = useCallback(() => setIsEmailComposerOpen(false), []);

  const openHarvester = useCallback(() => setIsHarvesterOpen(true), []);
  const closeHarvester = useCallback(() => setIsHarvesterOpen(false), []);

  const openEditForm = useCallback(() => setShowEditForm(true), []);
  const closeEditForm = useCallback(() => setShowEditForm(false), []);

  const openDeleteConfirm = useCallback(() => setShowDeleteConfirm(true), []);
  const closeDeleteConfirm = useCallback(() => setShowDeleteConfirm(false), []);

  return {
    // Email Composer
    isEmailComposerOpen,
    openEmailComposer,
    closeEmailComposer,
    
    // Document Harvester
    isHarvesterOpen,
    openHarvester,
    closeHarvester,
    
    // Edit Form
    showEditForm,
    openEditForm,
    closeEditForm,
    
    // Delete Confirmation
    showDeleteConfirm,
    openDeleteConfirm,
    closeDeleteConfirm,
  };
}