import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, X, Edit2, AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * EditableExtractedField - Inline editable field with confidence scoring
 * Shows confidence badge and allows user corrections
 */

const FIELD_LABELS = {
  name: 'Full Name',
  full_name: 'Full Name',
  date_of_birth: 'Date of Birth',
  dob: 'Date of Birth',
  ssn: 'SSN',
  social_security: 'Social Security',
  green_card_number: 'Green Card #',
  address: 'Address',
  street_address: 'Street Address',
  city: 'City',
  state: 'State',
  zip: 'ZIP Code',
  zip_code: 'ZIP Code',
  postal_code: 'Postal Code',
  email: 'Email',
  phone: 'Phone',
  phone_number: 'Phone Number',
  age: 'Age',
  id_number: 'ID Number',
  drivers_license_number: 'License #',
  passport_number: 'Passport #',
  document_type: 'Document Type',
  expiration_date: 'Expiration Date',
  issue_date: 'Issue Date',
  gender: 'Gender',
  height: 'Height',
  weight: 'Weight',
  eye_color: 'Eye Color'
};

export default function EditableExtractedField({
  fieldKey,
  fieldName,
  value,
  confidence,
  userCorrected = false,
  onChange,
  onRemove,
  isMissing = false
}) {
  const [isEditing, setIsEditing] = useState(isMissing);
  const [editValue, setEditValue] = useState(value || '');

  const getConfidenceBadge = () => {
    if (userCorrected) {
      return (
        <Badge className="bg-blue-100 text-blue-800 ml-2">
          <CheckCircle className="w-3 h-3 mr-1" aria-hidden="true" />
          Verified
        </Badge>
      );
    }
    
    if (confidence >= 0.90) {
      return (
        <Badge className="bg-green-100 text-green-800 ml-2">
          <CheckCircle className="w-3 h-3 mr-1" aria-hidden="true" />
          High ({Math.round(confidence * 100)}%)
        </Badge>
      );
    } else if (confidence >= 0.70) {
      return (
        <Badge className="bg-yellow-100 text-yellow-800 ml-2">
          <AlertTriangle className="w-3 h-3 mr-1" aria-hidden="true" />
          Medium ({Math.round(confidence * 100)}%)
        </Badge>
      );
    } else {
      return (
        <Badge className="bg-red-100 text-red-800 ml-2">
          <AlertTriangle className="w-3 h-3 mr-1" aria-hidden="true" />
          Low ({Math.round(confidence * 100)}%)
        </Badge>
      );
    }
  };

  const displayLabel = FIELD_LABELS[fieldKey.toLowerCase()] || fieldName.replace(/_/g, ' ');

  const handleSave = () => {
    onChange(editValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div 
      className={`flex items-center justify-between p-3 rounded-lg ${
        isEditing ? 'bg-blue-50 ring-2 ring-blue-300' : 
        isMissing ? 'bg-red-50 ring-2 ring-red-300' :
        confidence < 0.70 && !userCorrected ? 'bg-yellow-50' : 'bg-slate-50'
      }`}
      role="group"
      aria-label={`${displayLabel} field${isMissing ? ' (missing - please fill)' : ''}`}
    >
      {isEditing ? (
        <div className="flex-1 flex items-center gap-2">
          <Label className="w-28 text-sm font-medium shrink-0">{displayLabel}</Label>
          <Input
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 border-blue-300 focus:ring-blue-500"
            autoFocus
            aria-label={`Edit ${displayLabel}`}
          />
          <Button 
            size="sm" 
            variant="ghost" 
            onClick={handleSave}
            aria-label="Save changes"
          >
            <Check className="w-4 h-4 text-green-600" aria-hidden="true" />
          </Button>
          <Button 
            size="sm" 
            variant="ghost" 
            onClick={handleCancel}
            aria-label="Cancel editing"
          >
            <X className="w-4 h-4 text-red-600" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap">
              <span className="text-sm font-medium text-slate-700">
                {displayLabel}
                {isMissing && <span className="text-red-600 ml-1">*</span>}
              </span>
              {!isMissing && getConfidenceBadge()}
              {isMissing && (
                <Badge className="bg-red-100 text-red-800 ml-2">
                  <AlertTriangle className="w-3 h-3 mr-1" aria-hidden="true" />
                  Missing - Required
                </Badge>
              )}
            </div>
            <span className="text-sm text-slate-900 block truncate">
              {value || <span className="text-red-500 italic">Click edit to fill</span>}
            </span>
          </div>
          <div className="flex gap-1 shrink-0">
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={() => setIsEditing(true)}
              aria-label={`Edit ${displayLabel}`}
            >
              <Edit2 className="w-4 h-4 text-slate-500" aria-hidden="true" />
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={onRemove}
              aria-label={`Remove ${displayLabel}`}
            >
              <X className="w-4 h-4 text-red-500" aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}