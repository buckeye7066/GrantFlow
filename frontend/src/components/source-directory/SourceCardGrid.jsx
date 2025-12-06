import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Filter, CheckSquare, Trash2 } from 'lucide-react';
import { formatSourceTypeLabel } from '@/components/shared/sourceDirectoryUtils';

/**
 * Grid of source type cards with quick actions
 */
export default function SourceCardGrid({ 
  sourcesByType, 
  onViewAndSelect, 
  onSelectAll, 
  onDeleteByType 
}) {
  if (Object.keys(sourcesByType).length === 0) return null;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Sources by Type - Quick Actions</CardTitle>
        <p className="text-sm text-slate-600 mt-2">
          Filter to a specific type to select and delete individual sources, or delete all at once
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(sourcesByType).map(([type, typeSources]) => (
            <div key={type} className="p-4 bg-slate-50 rounded-lg border hover:border-blue-300 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold capitalize">
                    {formatSourceTypeLabel(type)}
                  </p>
                  <Badge variant="outline" className="mt-1">{typeSources.length} sources</Badge>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200"
                  onClick={() => onViewAndSelect(type)}
                >
                  <Filter className="w-3 h-3 mr-1" />
                  View & Select
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border-emerald-200"
                  onClick={() => onSelectAll(type)}
                >
                  <CheckSquare className="w-3 h-3 mr-1" />
                  Select All {typeSources.length}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => onDeleteByType(type)}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Delete All
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}