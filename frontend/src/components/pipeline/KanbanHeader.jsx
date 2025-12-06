import React from 'react';
import { Badge } from '@/components/ui/badge';
import { 
  Layers, 
  Eye, 
  FileEdit, 
  Send, 
  Award, 
  Archive, 
  XCircle, 
  HardHat, 
  FileBarChart,
  CheckCircle 
} from 'lucide-react';

const ICON_MAP = {
  Layers,
  Eye,
  FileEdit,
  Send,
  Award,
  Archive,
  XCircle,
  HardHat,
  FileBarChart,
  CheckCircle
};

/**
 * KanbanHeader - Column header with icon, label, and count
 * @param {Object} props
 * @param {string} props.label - Status label
 * @param {string} props.iconName - Icon name from lucide-react
 * @param {string} props.colorClass - Tailwind color class
 * @param {number} props.count - Number of grants in column
 */
export default function KanbanHeader({ label, iconName, colorClass, count = 0 }) {
  const Icon = ICON_MAP[iconName] || Layers;

  return (
    <div className={`${colorClass} p-3 rounded-t-lg sticky top-0 z-10`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{label}</h3>
        </div>
        <Badge 
          variant="secondary" 
          className="bg-white/80 hover:bg-white text-slate-700"
        >
          {count}
        </Badge>
      </div>
    </div>
  );
}