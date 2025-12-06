import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

/**
 * Profile/Organization selector for NOFO parsing
 */
export default function ProfileSelector({ 
  selectedOrgId, 
  onOrgChange, 
  organizations, 
  isLoading,
  disabled 
}) {
  return (
    <div>
      <Label htmlFor="org-select" className="text-base font-semibold mb-2 block">
        Link to Profile
      </Label>
      <Select 
        value={selectedOrgId} 
        onValueChange={onOrgChange} 
        disabled={disabled || isLoading}
        required
      >
        <SelectTrigger 
          id="org-select" 
          className="text-base h-12 mt-2"
          aria-label="Select organization profile"
        >
          <SelectValue placeholder="Select a profile to associate this grant with..." />
        </SelectTrigger>
        <SelectContent>
          {isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : (
            organizations.map(org => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}