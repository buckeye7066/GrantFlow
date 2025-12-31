import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { GripVertical, Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from "sonner";

const toKebabCase = (str) =>
  str &&
  str
    .match(/[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g)
    .map((x) => x.toLowerCase())
    .join('-');

export default function TaxonomyManagerModal({ group, open, onClose, onSave }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState('');

  const { data: taxonomyItems, isLoading } = useQuery({
    queryKey: ['taxonomy', group],
    queryFn: () => base44.entities.Taxonomy.filter({ group }, 'sort_order'),
    enabled: !!group && open,
  });

  useEffect(() => {
    if (taxonomyItems) {
      setItems(taxonomyItems);
    }
  }, [taxonomyItems]);

  const updateItemMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Taxonomy.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', group] });
    },
  });

  const createItemMutation = useMutation({
    mutationFn: (data) => base44.entities.Taxonomy.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', group] });
      setNewItem('');
    },
  });
  
  const bulkUpdateMutation = useMutation({
    mutationFn: (updates) => Promise.all(updates.map(u => base44.entities.Taxonomy.update(u.id, u.data))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['taxonomy', group] });
      toast.success("Changes saved successfully!");
      onSave();
    },
    onError: (error) => {
      toast.error(`Failed to save changes: ${error.message}`);
    }
  });

  const handleAddItem = () => {
    if (!newItem.trim()) return;
    const maxSortOrder = items.reduce((max, item) => Math.max(max, item.sort_order), -1);
    createItemMutation.mutate({
      group,
      label: newItem.trim(),
      slug: toKebabCase(newItem.trim()),
      active: true,
      sort_order: maxSortOrder + 1,
    });
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;
    const reorderedItems = Array.from(items);
    const [removed] = reorderedItems.splice(result.source.index, 1);
    reorderedItems.splice(result.destination.index, 0, removed);
    setItems(reorderedItems.map((item, index) => ({ ...item, sort_order: index })));
  };

  const handleSave = () => {
    const updates = items.map(item => ({ id: item.id, data: { sort_order: item.sort_order, active: item.active, label: item.label } }));
    bulkUpdateMutation.mutate(updates);
  };

  const handleLabelChange = (id, newLabel) => {
    setItems(items.map(item => item.id === id ? { ...item, label: newLabel } : item));
  }
  
  const handleActiveChange = (id, checked) => {
    setItems(items.map(item => item.id === id ? { ...item, active: checked } : item));
  };
  
  const groupTitle = group ? group.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : '';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage Options for "{groupTitle}"</DialogTitle>
        </DialogHeader>
        <div className="py-4 max-h-[60vh] overflow-y-auto pr-2">
          {isLoading ? (
            <div className="flex justify-center items-center h-40">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="taxonomy-items">
                {(provided) => (
                  <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">
                    {items.map((item, index) => (
                      <Draggable key={item.id} draggableId={item.id} index={index}>
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className="flex items-center gap-2 p-2 bg-slate-50 rounded-md border"
                          >
                            <span {...provided.dragHandleProps} className="cursor-grab text-slate-400">
                              <GripVertical />
                            </span>
                            <Input
                              value={item.label}
                              onChange={(e) => handleLabelChange(item.id, e.target.value)}
                              className="flex-grow"
                            />
                            <Switch
                              checked={item.active}
                              onCheckedChange={(checked) => handleActiveChange(item.id, checked)}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          )}
        </div>
        <div className="flex gap-2 pt-4 border-t">
          <Input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            placeholder="Add new option..."
            onKeyPress={(e) => e.key === 'Enter' && handleAddItem()}
            className="flex-grow"
          />
          <Button onClick={handleAddItem} disabled={createItemMutation.isPending}>
            <Plus className="w-4 h-4 mr-2" />
            Add
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={bulkUpdateMutation.isPending}>
            {bulkUpdateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}