-- Migration 0032: Expand grants.status CHECK constraint to include all pipeline UI statuses
-- The old constraint only allowed: discovered, interested, drafting, app_prep, revision,
-- submitted, under_review, awarded, rejected, closed, archived
-- The new constraint adds: discovery, auto_applied, application_prep, portal,
-- pending_review, follow_up, report, declined_no_review, declined
-- and keeps all legacy values for backward compatibility.

-- Step 1: Drop the existing CHECK constraint
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_status_check;

-- Step 2: Add the expanded CHECK constraint with all UI + legacy statuses
ALTER TABLE grants ADD CONSTRAINT grants_status_check CHECK (status IN (
    -- Current UI statuses (match KanbanBoard exactly)
    'discovery',
    'discovered',
    'interested',
    'auto_applied',
    'drafting',
    'application_prep',
    'revision',
    'portal',
    'submitted',
    'pending_review',
    'follow_up',
    'awarded',
    'report',
    'declined_no_review',
    'declined',
    'closed',
    -- Legacy statuses (keep for backward compatibility with existing data)
    'app_prep',
    'under_review',
    'rejected',
    'archived'
  ));
