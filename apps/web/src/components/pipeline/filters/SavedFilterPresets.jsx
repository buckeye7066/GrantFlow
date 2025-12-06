import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Save, Trash2, BookmarkPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * SavedFilterPresets - Manage saved filter presets
 * @param {Object} props
 * @param {Object} props.currentFilters - Current filter values
 * @param {Function} props.onLoadPreset - Handler when preset is loaded
 * @param {Array} props.presets - Array of saved presets
 * @param {Function} props.onSavePreset - Handler to save new preset
 * @param {Function} props.onDeletePreset - Handler to delete preset
 */
export default function SavedFilterPresets({ 
  currentFilters, 
  onLoadPreset, 
  presets,
  onSavePreset,
  onDeletePreset 
}) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');

  // Normalize presets to array with valid entries
  const safePresets = Array.isArray(presets)
    ? presets.filter((p) => p && typeof p === 'object' && p.id && p.name)
    : [];

  // Normalize currentFilters
  const safeFilters = currentFilters && typeof currentFilters === 'object' ? currentFilters : {};

  const handleSavePreset = () => {
    if (!presetName.trim() || typeof onSavePreset !== 'function') return;
    
    onSavePreset({
      name: presetName.trim(),
      filters: safeFilters,
      created_at: new Date().toISOString()
    });
    
    setPresetName('');
    setShowSaveDialog(false);
  };

  const handleLoadPreset = (presetId) => {
    if (!presetId || typeof onLoadPreset !== 'function') return;
    const preset = safePresets.find(p => p.id === presetId);
    if (preset && preset.filters) {
      onLoadPreset(preset.filters);
      setSelectedPreset(presetId);
    }
  };

  const countActiveFilters = (filters) => {
    return Object.entries(filters).filter(([key, value]) => {
      if (key === 'search') return value.length > 0;
      if (key === 'minAmount' || key === 'maxAmount') return value !== '';
      if (key === 'matchScoreMin') return value > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'boolean') return value === true;
      return false;
    }).length;
  };

  return (
    <div className="flex items-center gap-2" role="group" aria-label="Saved filter presets">
      {/* Load Preset Dropdown */}
      {safePresets.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-600 whitespace-nowrap">Saved:</Label>
          <Select value={selectedPreset} onValueChange={handleLoadPreset}>
            <SelectTrigger className="w-[180px] h-9" aria-label="Select saved preset">
              <SelectValue placeholder="Load preset..." />
            </SelectTrigger>
            <SelectContent>
              {safePresets.map((preset) => (
                <SelectItem key={`preset-${String(preset.id)}`} value={preset.id}>
                  <div className="flex items-center justify-between w-full">
                    <span>{String(preset.name || 'Untitled')}</span>
                    <Badge variant="secondary" className="ml-2 text-xs">
                      {countActiveFilters(preset.filters || {})}
                    </Badge>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          {selectedPreset && typeof onDeletePreset === 'function' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                onDeletePreset(selectedPreset);
                setSelectedPreset('');
              }}
              className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
              aria-label="Delete selected preset"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {/* Save New Preset */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2 h-9">
            <BookmarkPlus className="w-4 h-4" />
            Save Preset
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Filter Preset</DialogTitle>
            <DialogDescription>
              Save your current filter settings for quick access later.
              {countActiveFilters(safeFilters) > 0 && (
                <span className="block mt-2 text-sm">
                  <Badge variant="secondary">
                    {countActiveFilters(safeFilters)} active filters
                  </Badge>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="preset-name">Preset Name</Label>
              <Input
                id="preset-name"
                placeholder="e.g., High Priority Grants"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSavePreset();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSavePreset} disabled={!presetName.trim()}>
              <Save className="w-4 h-4 mr-2" />
              Save Preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}