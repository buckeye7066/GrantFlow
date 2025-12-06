import React from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export default function InvoiceActionBar({ isSubmitting, isValid, onCancel }) {
  const navigate = useNavigate();

  return (
    <div className="flex justify-end gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={onCancel || (() => navigate(createPageUrl('Billing')))}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        disabled={isSubmitting || !isValid}
        className="bg-emerald-600 hover:bg-emerald-700"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Creating...
          </>
        ) : (
          'Create Invoice'
        )}
      </Button>
    </div>
  );
}