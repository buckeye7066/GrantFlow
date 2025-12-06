import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Edit, X, Save } from 'lucide-react';

export default function CheckboxBadgeSection({
  title = 'Section',
  icon: Icon,
  iconColor = 'text-blue-600',
  headerBg = 'bg-blue-50',
  headerTextColor = 'text-blue-900',
  badgeClass = 'bg-blue-100 text-blue-800',
  checkboxItems = [],
  organization,
  editingSection,
  sectionKey,
  currentData,
  isUpdating,
  onStartEdit,
  onCancelEdit,
  onSaveSection,
  onUpdateTempField,
  emptyMessage = 'No items recorded. Click edit to add.'
}) {
  const safeOrg = organization || {};
  const safeCurrentData = currentData || {};
  const safeCheckboxItems = Array.isArray(checkboxItems) ? checkboxItems : [];
  
  const dataSource = editingSection === sectionKey ? safeCurrentData : safeOrg;
  const hasAnyValue = safeCheckboxItems.some(item => dataSource[item?.id]);

  return (
    <Card className={`border-${iconColor.split('-')[1]}-200`}>
      <CardHeader className={`${headerBg} flex flex-row items-center justify-between`}>
        <CardTitle className={`${headerTextColor} flex items-center gap-2`}>
          {Icon && <Icon className={`w-5 h-5 ${iconColor}`} />}
          {title}
        </CardTitle>
        {editingSection !== sectionKey ? (
          <Button variant="ghost" size="sm" onClick={() => onStartEdit(sectionKey)} disabled={isUpdating}>
            <Edit className="w-4 h-4" />
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
              <X className="w-4 h-4" />
            </Button>
            <Button variant="default" size="sm" onClick={onSaveSection} disabled={isUpdating}>
              <Save className="w-4 h-4" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {editingSection === sectionKey ? (
          <div className="grid grid-cols-2 gap-3">
            {safeCheckboxItems.map(item => {
              const safeItem = item || {};
              return (
                <div key={safeItem.id || Math.random()} className="flex items-center space-x-2">
                  <Checkbox
                    id={safeItem.id}
                    checked={!!(safeCurrentData[safeItem.id])}
                    onCheckedChange={(checked) => onUpdateTempField(safeItem.id, checked)}
                  />
                  <Label htmlFor={safeItem.id} className="text-sm">{safeItem.label || 'Unknown'}</Label>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {safeCheckboxItems.map(item => {
              const safeItem = item || {};
              return dataSource[safeItem.id] && (
                <Badge key={safeItem.id || Math.random()} className={badgeClass}>{safeItem.label || 'Unknown'}</Badge>
              );
            })}
            {!hasAnyValue && (
              <p className="text-sm text-slate-500 italic">{emptyMessage}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}