import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Target, Search, Loader2, Calendar, Star, Trash2, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { useThemeSettings } from '@/components/theme/ThemeSettingsProvider';

// Safe date formatter - never throws
const safeFormatDate = (value, formatStr = 'MMM d, yyyy', fallback = '') => {
  if (!value) return fallback;
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) return fallback;
    return format(date, formatStr);
  } catch {
    return fallback;
  }
};

// Status configuration
const STATUS_CONFIG = {
  discovered: { label: 'Discovered', className: 'bg-slate-100 text-slate-700' },
  interested: { label: 'Interested', className: 'bg-blue-100 text-blue-700' },
  auto_applied: { label: 'Auto Applied', className: 'bg-purple-100 text-purple-700' },
  drafting: { label: 'Drafting', className: 'bg-amber-100 text-amber-700' },
  portal: { label: 'Portal', className: 'bg-indigo-100 text-indigo-700' },
  application_prep: { label: 'App Prep', className: 'bg-orange-100 text-orange-700' },
  revision: { label: 'Revision', className: 'bg-yellow-100 text-yellow-700' },
  submitted: { label: 'Submitted', className: 'bg-emerald-100 text-emerald-700' },
  awarded: { label: 'Awarded', className: 'bg-green-100 text-green-700' },
  declined: { label: 'Declined', className: 'bg-red-100 text-red-700' },
  closed: { label: 'Closed', className: 'bg-slate-100 text-slate-700' },
  report: { label: 'Reporting', className: 'bg-cyan-100 text-cyan-700' },
};

// number coercion helper
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Opportunities tab - displays grants for this profile (limited to first 10)
 */
export default function OpportunitiesTab({ grants = [], isLoading, organizationId }) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [deletingId, setDeletingId] = useState(null);
  const [addingId, setAddingId] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { accentColor, themeClasses } = useThemeSettings();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['grants'] });
    if (organizationId) {
      queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
    }
  };

  const handleDelete = async (e, grantId) => {
    e.preventDefault();
    e.stopPropagation();
    setDeletingId(grantId);
    try {
      await base44.entities.Grant.delete(grantId);
      toast({ title: 'Removed', description: 'Opportunity removed from list.' });
      invalidate();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to remove opportunity.' });
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddToPipeline = async (e, grant) => {
    e.preventDefault();
    e.stopPropagation();
    setAddingId(grant.id);
    try {
      await base44.entities.Grant.update(grant.id, { status: 'interested' });
      toast({ title: 'Added to Pipeline', description: `"${grant.title}" moved to Interested stage.` });
      invalidate();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to add to pipeline.' });
    } finally {
      setAddingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Limit to first 10 opportunities
  const safeGrants = Array.isArray(grants) ? grants : [];
  const displayGrants = safeGrants.slice(0, 10);
  const hasMore = safeGrants.length > 10;

  return (
    <Card className={`mt-4 ${themeClasses.surface}`}>
      <CardHeader className="border-b border-white/10 backdrop-blur-sm bg-white/5">
        <CardTitle className="flex items-center gap-2" style={{ color: accentColor }}>
          <Target className="w-5 h-5" />
          Funding Opportunities ({safeGrants.length})
        </CardTitle>
        <p className="text-sm text-slate-600 mt-2">
          {hasMore
            ? `Showing first 10 of ${safeGrants.length} opportunities discovered for this profile`
            : 'All opportunities discovered and tracked for this profile'}
        </p>
      </CardHeader>
      <CardContent>
        {safeGrants.length === 0 ? (
          <div className="text-center py-16 bg-slate-50 rounded-lg border">
            <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">No Opportunities Yet</h3>
            <p className="text-slate-600 mb-4">Start by discovering grants for this profile.</p>
            <Link to={createPageUrl('DiscoverGrants')}>
              <Button className="bg-blue-600 hover:bg-blue-700">
                <Search className="w-4 h-4 mr-2" />
                Discover Grants
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {/* Horizontal scroll slider */}
            <div className="flex items-center gap-4 mb-4 p-3 bg-slate-50 rounded-lg border">
              <span className="text-sm text-slate-600 whitespace-nowrap">Scroll:</span>
              <Slider
                value={[scrollOffset]}
                onValueChange={(val) => setScrollOffset(val[0])}
                min={0}
                max={100}
                step={1}
                className="flex-1"
              />
              <span className="text-xs text-slate-500 w-10">{scrollOffset}%</span>
            </div>

            <div
              className="space-y-2 overflow-x-auto"
              style={{
                maxWidth: '100%',
                transform: `translateX(-${scrollOffset * 2}px)`,
                transition: 'transform 0.1s ease-out',
              }}
            >
              {displayGrants.map((grant) => {
                if (!grant || typeof grant !== 'object') return null;

                const statusBadge = STATUS_CONFIG[grant.status] || { label: 'Unknown', className: 'bg-slate-100 text-slate-700' };
                const amount = toNum(grant.typical_award) || toNum(grant.award_ceiling) || toNum(grant.award_floor);
                const deadlineText = safeFormatDate(grant.deadline);
                const isDiscovered = grant.status === 'discovered';

                return (
                  <div key={grant.id} className="flex items-center gap-2" style={{ minWidth: '700px' }}>
                    <Link to={createPageUrl(`GrantDetail?id=${grant.id}`)} className="flex-1">
                      <div className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50 hover:border-blue-300 transition-all cursor-pointer">
                        <div className="flex-1 min-w-0 pr-4">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold text-slate-900 truncate">{grant.title || 'Untitled Opportunity'}</h4>
                            {grant.starred && <Star className="w-4 h-4 text-yellow-400 fill-yellow-400 shrink-0" />}
                          </div>
                          <p className="text-sm text-slate-600 truncate">{grant.funder || 'Unknown Funder'}</p>
                          {deadlineText && (
                            <div className="flex items-center gap-1 mt-1">
                              <Calendar className="w-3 h-3 text-slate-400" />
                              <span className="text-xs text-slate-500">{deadlineText}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {amount > 0 && (
                            <div className="text-right">
                              <div className="text-sm font-semibold text-emerald-600">
                                ${amount.toLocaleString()}
                              </div>
                              <div className="text-xs text-slate-500">Award</div>
                            </div>
                          )}
                          <Badge className={statusBadge.className}>{statusBadge.label}</Badge>
                        </div>
                      </div>
                    </Link>

                    {/* Action buttons */}
                    <div className="flex flex-col gap-1 shrink-0">
                      {isDiscovered && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600 border-green-300 hover:bg-green-50"
                          onClick={(e) => handleAddToPipeline(e, grant)}
                          disabled={addingId === grant.id}
                        >
                          {addingId === grant.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <Plus className="w-4 h-4 mr-1" />
                              Add
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-300 hover:bg-red-50"
                        onClick={(e) => handleDelete(e, grant.id)}
                        disabled={deletingId === grant.id}
                      >
                        {deletingId === grant.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Trash2 className="w-4 h-4 mr-1" />
                            Remove
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}

              {hasMore && (
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
                  <p className="text-sm text-blue-900 mb-2">
                    <strong>{safeGrants.length - 10} more opportunities</strong> available for this profile
                  </p>
                  <p className="text-xs text-blue-700">View all opportunities on the Pipeline page</p>
                  <Link to={createPageUrl('Pipeline')}>
                    <Button variant="outline" size="sm" className="mt-2">
                      View All in Pipeline
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}