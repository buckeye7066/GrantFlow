import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/**
 * Reusable form section wrapper with consistent styling
 * 
 * @param {Object} props
 * @param {string} props.title - Section title
 * @param {string} [props.description] - Section description
 * @param {React.ComponentType} [props.icon] - Icon component
 * @param {React.ReactNode} props.children - Form fields
 * @param {string} [props.borderColor='border-slate-200'] - Tailwind border color class
 * @param {string} [props.bgColor='bg-slate-50'] - Tailwind background color class
 * @param {string} [props.id] - Optional id for accessibility linking
 * @param {boolean} [props.required=false] - Whether the section has required fields
 */
export default function FormSection({ 
  title = 'Section', 
  description, 
  icon: Icon, 
  children,
  borderColor = 'border-slate-200',
  bgColor = 'bg-slate-50',
  id,
  required = false,
}) {
  const sectionId = id || `section-${title?.toLowerCase().replace(/\s+/g, '-') || 'default'}`;

  return (
    <Card 
      className={borderColor}
      role="group"
      aria-labelledby={`${sectionId}-title`}
    >
      <CardHeader className={bgColor}>
        <CardTitle 
          id={`${sectionId}-title`}
          className="text-base flex items-center gap-2"
        >
          {Icon && <Icon className="w-5 h-5" aria-hidden="true" />}
          {title}
          {required && (
            <span className="text-red-500 text-sm" aria-label="required">*</span>
          )}
        </CardTitle>
        {description && (
          <CardDescription className="text-xs">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {children}
      </CardContent>
    </Card>
  );
}