import React, { useState, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { 
  GraduationCap, 
  ExternalLink, 
  CheckCircle2, 
  Clock, 
  AlertTriangle,
  Calendar,
  Square,
  CheckSquare
} from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';

// Named constants
const FAFSA_DEADLINE = new Date('2025-06-30');
const FAFSA_OPEN_DATE = new Date('2024-12-01');
const URGENT_DAYS_THRESHOLD = 30;

// Status constants
const STATUS_COMPLETED = 'completed';
const STATUS_IN_PROGRESS = 'in_progress';
const STATUS_NOT_STARTED = 'not_started';

// Student applicant types
const STUDENT_TYPES = ['high_school_student', 'college_student', 'graduate_student'];

/** Safe differenceInDays - returns 0 on error */
function safeDifferenceInDays(date, baseDate) {
  if (!date || !baseDate) return 0;
  try {
    return differenceInDays(date, baseDate);
  } catch {
    return 0;
  }
}

/** Safe format date */
const safeFormatDate = (date, formatStr) => {
  if (!date) return 'Invalid date';
  try {
    return format(date, formatStr);
  } catch {
    return 'Invalid date';
  }
};

/** Safe external link open with fallback */
const safeOpenLink = (url, fallbackElement) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  } catch (err) {
    console.error('[FAFSAStatusCard] Failed to open link:', err);
    // Fallback handled by using <a href> in JSX
    return false;
  }
};

/** Generate deterministic fallback ID for profiles */
const getProfileFallbackId = (profile) => {
  const name = (profile.name || 'student').replace(/\s+/g, '-').substring(0, 30);
  return `profile-${name}`;
};

export default function FAFSAStatusCard({ organizations = [] }) {
  const queryClient = useQueryClient();
  const [updatingId, setUpdatingId] = useState(null);

  // Memoize student profiles
  const studentProfiles = useMemo(() => {
    const safeOrgs = Array.isArray(organizations) ? organizations : [];
    return safeOrgs.filter(org => STUDENT_TYPES.includes(org?.applicant_type));
  }, [organizations]);

  // Memoize FAFSA statuses
  const fafsaStatuses = useMemo(() => {
    return studentProfiles.map(profile => ({
      id: profile?.id ?? getProfileFallbackId(profile),
      name: profile?.name || 'Unknown Student',
      status: profile?.fafsa_status || STATUS_NOT_STARTED,
      submittedDate: profile?.fafsa_submitted_date,
      sai: profile?.efc_sai_band,
      completedExternally: profile?.fafsa_completed_externally || false
    }));
  }, [studentProfiles]);

  // Memoize counts
  const { completedCount, inProgressCount, notStartedCount } = useMemo(() => ({
    completedCount: fafsaStatuses.filter(s => s.status === STATUS_COMPLETED).length,
    inProgressCount: fafsaStatuses.filter(s => s.status === STATUS_IN_PROGRESS).length,
    notStartedCount: fafsaStatuses.filter(s => s.status === STATUS_NOT_STARTED).length,
  }), [fafsaStatuses]);

  // Memoize deadline calculations - depends on organizations to recalculate when data changes
  const { daysUntilDeadline, isUrgent, isPastDeadline } = useMemo(() => {
    const now = new Date();
    const days = safeDifferenceInDays(FAFSA_DEADLINE, now);
    return {
      daysUntilDeadline: days,
      isUrgent: days <= URGENT_DAYS_THRESHOLD && days > 0,
      isPastDeadline: days < 0,
    };
  }, [organizations]);

  const handleToggleStatus = useCallback(async (studentId, currentStatus) => {
    if (!studentId || updatingId) return;
    
    setUpdatingId(studentId);
    try {
      let newStatus = STATUS_NOT_STARTED;
      if (currentStatus === STATUS_NOT_STARTED) newStatus = STATUS_IN_PROGRESS;
      else if (currentStatus === STATUS_IN_PROGRESS) newStatus = STATUS_COMPLETED;
      else if (currentStatus === STATUS_COMPLETED) newStatus = STATUS_NOT_STARTED;
      
      await base44.entities.Organization.update(studentId, { 
        fafsa_status: newStatus,
        fafsa_submitted_date: newStatus === STATUS_COMPLETED ? new Date().toISOString() : null
      });
      
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    } catch (err) {
      console.error('Failed to update FAFSA status:', err);
    } finally {
      setUpdatingId(null);
    }
  }, [queryClient, updatingId]);

  // Toggle the "completed externally" checkbox
  const handleToggleCompletedExternally = useCallback(async (studentId, currentValue) => {
    if (!studentId || updatingId) return;
    
    setUpdatingId(studentId);
    try {
      const newValue = !currentValue;
      await base44.entities.Organization.update(studentId, { 
        fafsa_completed_externally: newValue,
        // If marking as completed externally, also set status to completed
        ...(newValue ? { fafsa_status: STATUS_COMPLETED } : {})
      });
      
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    } catch (err) {
      console.error('Failed to update FAFSA completed externally:', err);
    } finally {
      setUpdatingId(null);
    }
  }, [queryClient, updatingId]);

  // Keyboard handler for status badge
  const handleStatusKeyDown = useCallback((e, studentId, status) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleStatus(studentId, status);
    }
  }, [handleToggleStatus]);

  // Keyboard handler for checkbox
  const handleCheckboxKeyDown = useCallback((e, studentId, currentValue) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleCompletedExternally(studentId, currentValue);
    }
  }, [handleToggleCompletedExternally]);

  const getStatusBadge = useCallback((status, studentId) => {
    const isUpdating = updatingId === studentId;
    const baseClass = "cursor-pointer hover:opacity-80 transition-opacity";
    const disabledClass = isUpdating ? 'opacity-50 cursor-wait' : '';
    
    const handleClick = () => {
      if (!isUpdating) {
        handleToggleStatus(studentId, status);
      }
    };

    switch (status) {
      case STATUS_COMPLETED:
        return (
          <Badge 
            className={`bg-green-100 text-green-800 ${baseClass} ${disabledClass}`}
            onClick={handleClick}
            onKeyDown={(e) => handleStatusKeyDown(e, studentId, status)}
            role="button"
            tabIndex={0}
            aria-label={`Status: Completed. Click to change.${isUpdating ? ' Updating...' : ''}`}
            aria-disabled={isUpdating}
          >
            {isUpdating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
            Completed
          </Badge>
        );
      case STATUS_IN_PROGRESS:
        return (
          <Badge 
            className={`bg-amber-100 text-amber-800 ${baseClass} ${disabledClass}`}
            onClick={handleClick}
            onKeyDown={(e) => handleStatusKeyDown(e, studentId, status)}
            role="button"
            tabIndex={0}
            aria-label={`Status: In Progress. Click to change.${isUpdating ? ' Updating...' : ''}`}
            aria-disabled={isUpdating}
          >
            {isUpdating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Clock className="w-3 h-3 mr-1" />}
            In Progress
          </Badge>
        );
      default:
        return (
          <Badge 
            className={`bg-slate-100 text-slate-800 ${baseClass} ${disabledClass}`}
            onClick={handleClick}
            onKeyDown={(e) => handleStatusKeyDown(e, studentId, status)}
            role="button"
            tabIndex={0}
            aria-label={`Status: Not Started. Click to change.${isUpdating ? ' Updating...' : ''}`}
            aria-disabled={isUpdating}
          >
            {isUpdating && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            Not Started
          </Badge>
        );
    }
  }, [updatingId, handleToggleStatus, handleStatusKeyDown]);

  if (studentProfiles.length === 0) {
    return null;
  }

  return (
    <Card 
      className={`border-2 ${isUrgent ? 'border-amber-400 bg-amber-50' : isPastDeadline ? 'border-red-400 bg-red-50' : 'border-blue-200'}`}
      role="region"
      aria-label="FAFSA status tracker"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-blue-600" aria-hidden="true" />
            FAFSA Status
          </span>
          <Button variant="outline" size="sm" asChild>
            <a href="https://studentaid.gov/h/apply-for-aid/fafsa" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-4 h-4 mr-1" aria-hidden="true" />
              Open FAFSA
            </a>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Deadline Alert */}
        <div 
          className={`p-3 rounded-lg ${isUrgent ? 'bg-amber-100' : isPastDeadline ? 'bg-red-100' : 'bg-blue-50'}`}
          role="alert"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            {isUrgent && <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />}
            <Calendar className="w-4 h-4 text-slate-600" aria-hidden="true" />
            <span className="font-medium">
              Federal Deadline: {safeFormatDate(FAFSA_DEADLINE, 'MMMM d, yyyy')}
            </span>
          </div>
          <p className={`text-sm mt-1 ${isUrgent ? 'text-amber-700 font-semibold' : isPastDeadline ? 'text-red-700' : 'text-slate-600'}`}>
            {isPastDeadline 
              ? 'Federal deadline has passed. Check state deadlines.'
              : isUrgent 
                ? `⚠️ Only ${daysUntilDeadline} days remaining!`
                : `${daysUntilDeadline} days remaining`
            }
          </p>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-3 text-center" role="group" aria-label="FAFSA completion summary">
          <div className="p-2 bg-green-50 rounded-lg">
            <p className="text-2xl font-bold text-green-600">{completedCount}</p>
            <p className="text-xs text-slate-600">Completed</p>
          </div>
          <div className="p-2 bg-amber-50 rounded-lg">
            <p className="text-2xl font-bold text-amber-600">{inProgressCount}</p>
            <p className="text-xs text-slate-600">In Progress</p>
          </div>
          <div className="p-2 bg-slate-50 rounded-lg">
            <p className="text-2xl font-bold text-slate-600">{notStartedCount}</p>
            <p className="text-xs text-slate-600">Not Started</p>
          </div>
        </div>

        {/* Student List */}
        <div 
          className="space-y-2 max-h-48 overflow-y-auto" 
          role="list" 
          aria-label="Student FAFSA statuses"
          tabIndex={0}
        >
          {fafsaStatuses.map(student => (
            <div 
              key={student.id} 
              className={`flex items-center justify-between p-2 bg-white rounded-lg border ${updatingId === student.id ? 'opacity-70' : ''}`}
              role="listitem"
            >
              <div className="flex items-center gap-2">
                {/* Completed Externally Checkbox */}
                <button
                  onClick={() => handleToggleCompletedExternally(student.id, student.completedExternally)}
                  onKeyDown={(e) => handleCheckboxKeyDown(e, student.id, student.completedExternally)}
                  className="text-slate-400 hover:text-green-600 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-1 rounded"
                  title={student.completedExternally ? "Marked as completed outside app" : "Click to mark as completed outside app"}
                  aria-label={student.completedExternally ? "Marked as completed outside app. Click to unmark." : "Click to mark as completed outside app"}
                  disabled={updatingId === student.id}
                  aria-disabled={updatingId === student.id}
                >
                  {student.completedExternally ? (
                    <CheckSquare className="w-5 h-5 text-green-600" aria-hidden="true" />
                  ) : (
                    <Square className="w-5 h-5" aria-hidden="true" />
                  )}
                </button>
                <div>
                  <p className="font-medium text-sm">{student.name}</p>
                  <div className="flex items-center gap-2">
                    {student.sai && <span className="text-xs text-slate-500">SAI: {student.sai}</span>}
                    {student.completedExternally && (
                      <span className="text-xs text-green-600">(Completed externally)</span>
                    )}
                  </div>
                </div>
              </div>
              {getStatusBadge(student.status, student.id)}
            </div>
          ))}
        </div>

        {/* Quick Links */}
        <div className="pt-2 border-t grid grid-cols-2 gap-2">
          <Button variant="ghost" size="sm" className="text-xs" asChild>
            <a href="https://studentaid.gov/fsa-id/create-account/launch" target="_blank" rel="noopener noreferrer">
              Create FSA ID
            </a>
          </Button>
          <Button variant="ghost" size="sm" className="text-xs" asChild>
            <a href="https://studentaid.gov/aid-estimator/" target="_blank" rel="noopener noreferrer">
              Aid Estimator
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}