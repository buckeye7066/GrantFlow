import { useState, useCallback } from 'react';

/**
 * Custom hook for managing invoice form state
 */
export function useInvoiceForm(initialState) {
  const [formData, setFormData] = useState(initialState);

  const updateField = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  }, []);

  const updateFields = useCallback((updates) => {
    setFormData(prev => ({ ...prev, ...updates }));
  }, []);

  return {
    formData,
    setFormData,
    updateField,
    updateFields,
  };
}