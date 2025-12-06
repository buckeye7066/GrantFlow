import React from 'react';
import { Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

/**
 * Empty state when no grants are found
 */
export default function MatchEmptyState({ message, showDiscoverButton = true }) {
  return (
    <div className="text-center py-16">
      <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
      <h3 className="text-xl font-semibold text-slate-800">
        {message || 'No Grants Found'}
      </h3>
      <p className="text-slate-600 mt-2 mb-4">
        This profile doesn't have any grants in the pipeline yet.
      </p>
      {showDiscoverButton && (
        <Link to={createPageUrl('DiscoverGrants')}>
          <Button className="bg-blue-600 hover:bg-blue-700">
            Discover Grants
          </Button>
        </Link>
      )}
    </div>
  );
}