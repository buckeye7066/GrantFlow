import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Star, Edit, Trash2, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import GrantMatchBadge from './GrantMatchBadge';

/**
 * GrantCardHeader - Header section with badges and menu
 * @param {Object} props
 * @param {Object} props.grant - Grant data
 * @param {boolean} props.isExpired - Whether deadline is expired
 * @param {boolean} props.showSummary - Show AI summary badge
 * @param {boolean} props.hasSummary - Has AI-generated summary
 * @param {number} props.matchScore - Match score
 * @param {Function} props.onStarToggle - Star toggle handler
 * @param {Function} props.onDelete - Delete handler
 * @param {boolean} props.showMenu - Show dropdown menu
 * @param {Function} props.onMenuChange - Menu state change handler
 */
export default function GrantCardHeader({
  grant,
  isExpired,
  showSummary,
  hasSummary,
  matchScore,
  onStarToggle,
  onDelete,
  showMenu,
  onMenuChange,
}) {
  return (
    <div className="flex items-center justify-between p-3 border-b border-slate-100">
      <div className="flex items-center gap-2 flex-wrap">
        {grant.starred && (
          <Star 
            className="w-4 h-4 text-yellow-400 fill-yellow-400 animate-pulse" 
            aria-label="Starred"
          />
        )}
        
        {isExpired && (
          <Badge variant="destructive" className="text-xs font-bold">
            EXPIRED
          </Badge>
        )}
        
        {hasSummary && showSummary && (
          <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100 transition-colors">
            <Sparkles className="w-3 h-3 mr-1" aria-hidden="true" />
            AI Summary
          </Badge>
        )}
        
        <GrantMatchBadge matchScore={matchScore} />
      </div>
      
      {(onStarToggle || onDelete) && (
        <DropdownMenu open={showMenu} onOpenChange={onMenuChange}>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 hover:bg-slate-100 transition-colors"
              aria-label="Grant options"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {onStarToggle && (
              <DropdownMenuItem 
                onClick={() => {
                  onStarToggle();
                  onMenuChange(false);
                }}
                className="cursor-pointer"
              >
                <Star className="w-4 h-4 mr-2" />
                {grant.starred ? 'Unstar' : 'Star'}
              </DropdownMenuItem>
            )}
            <Link to={createPageUrl(`GrantDetail?id=${grant.id}`)}>
              <DropdownMenuItem className="cursor-pointer">
                <Edit className="w-4 h-4 mr-2" />
                View Details
              </DropdownMenuItem>
            </Link>
            {onDelete && (
              <DropdownMenuItem 
                onClick={() => {
                  onDelete(grant);
                  onMenuChange(false);
                }} 
                className="text-red-600 cursor-pointer focus:text-red-600 focus:bg-red-50"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}