# Orphaned Profile Fix - Implementation Guide

## Overview

This fix addresses the issue where users could not delete or access profiles on the "My Profiles" page that were not properly linked to organizations. These "orphaned profiles" would show in the UI but would fail to load when clicked.

## Problem Description

### Original Issue
- Profiles appeared on the "My Profiles" page
- Clicking on certain profiles (e.g., "Olivia Beltran / Hybrid Healing" and "Hollie Machelle Knox") resulted in a "not found" error
- There was no way to delete these problematic profiles
- Users were blocked from managing their profile list

### Root Causes
1. **Navigation Bug**: ProfileCard was navigating using `profile.id` instead of `profile.organization_id`
2. **Missing Organization Link**: Profiles could exist with `organization_id = NULL` or pointing to deleted organizations
3. **No Delete Functionality**: There was no UI or API endpoint to delete profiles
4. **No Validation**: Backend didn't validate organization_id references when creating/updating profiles

## Solution Implemented

### 1. Fixed Navigation (Frontend)
**File**: `src/components/profiles/ProfileCard.jsx`

```javascript
// OLD: Navigated with profile.id
navigate(createPageUrl("OrganizationProfile", { id: profile.id }));

// NEW: Navigates with organization_id, or doesn't navigate if orphaned
const handleCardClick = () => {
  if (profile.organization_id) {
    navigate(createPageUrl("OrganizationProfile", { id: profile.organization_id }));
  }
  // If no organization_id, don't navigate (orphaned profile)
};
```

### 2. Visual Identification of Orphaned Profiles
**File**: `src/components/profiles/ProfileCard.jsx`

- Orphaned profiles are marked with an orange border
- Display a warning banner explaining the issue
- Show a "Delete Profile" button instead of normal actions

```javascript
const isOrphanedProfile = !profile.organization_id;

{isOrphanedProfile && (
  <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
    <AlertTriangle className="w-4 h-4 text-orange-600" />
    <p>Orphaned Profile</p>
    <p>This profile is not linked to an organization...</p>
  </div>
)}
```

### 3. Delete Functionality
**Files**: 
- `backend/routes/profiles.js` (DELETE endpoint)
- `src/api/profiles.js` (API client method)
- `src/pages/MyProfiles.jsx` (UI integration)

#### Backend DELETE Endpoint
```javascript
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const auth = req.user ?? { role: 'guest' };

  // Authorization checks...
  // Delete profile and cleanup avatar
  const stmt = req.db.prepare('DELETE FROM profiles WHERE id = ?');
  const result = stmt.run(id);
  
  res.status(204).send();
});
```

#### Frontend Integration
```javascript
const deleteMutation = useMutation({
  mutationFn: deleteProfile,
  onSuccess: () => {
    toast({ title: "Profile deleted" });
    queryClient.invalidateQueries({ queryKey: ['profiles'] });
  }
});
```

### 4. Backend Validation
**File**: `backend/routes/profiles.js`

Added validation to both POST and PUT endpoints:

```javascript
// In POST endpoint
if (organization_id) {
  const org = req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id);
  if (!org) {
    return res.status(400).json({ 
      error: 'Invalid organization_id: organization does not exist' 
    });
  }
}

// Same validation in PUT endpoint
```

## User Experience

### For Normal Profiles
- Click on profile card → Navigate to organization profile page
- Access "Invoices" and "Billing" buttons normally
- No visual warnings or special handling

### For Orphaned Profiles
1. **Visual Indicators**:
   - Orange border around card
   - Warning icon and message
   - Clear explanation that profile is orphaned

2. **Available Actions**:
   - Only action: "Delete Profile" button
   - Clicking card does nothing (no navigation)
   - No access to invoices or billing

3. **Deletion Flow**:
   - Click "Delete Profile" button
   - Confirmation dialog appears
   - Confirm deletion
   - Profile removed from list
   - Toast notification confirms success

## API Endpoints

### DELETE /api/profiles/:id
Delete a profile by ID.

**Authorization**:
- Admin users can delete any profile
- Regular users can only delete profiles they own (via `user_id` or `profileId`)

**Response**:
- `204 No Content` - Profile deleted successfully
- `403 Forbidden` - Not authorized
- `404 Not Found` - Profile doesn't exist

**Side Effects**:
- Cascading deletion of related records (profile_sections, profile_documents, billing_accounts)
- Avatar file cleanup if exists

### Validation in POST/PUT
Both profile creation and update now validate that `organization_id` references an existing organization.

**Error Response**:
```json
{
  "error": "Invalid organization_id: organization does not exist"
}
```

## Database Considerations

### Schema Relationships
```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  -- other fields...
);
```

- `ON DELETE SET NULL`: When an organization is deleted, profile's `organization_id` becomes NULL
- This creates orphaned profiles that can now be properly handled

### Cascade Deletion
When a profile is deleted:
```sql
profile_sections     → ON DELETE CASCADE
profile_documents    → ON DELETE CASCADE  
billing_accounts     → ON DELETE CASCADE
```

## Testing

### Unit Tests
Run the test scripts:

```bash
# Test orphaned profile logic
node scripts/test-orphaned-profiles.mjs

# Test API endpoints
node scripts/test-profiles-api.mjs
```

### Manual Testing

1. **Create an orphaned profile**:
   - Use SQL: `UPDATE profiles SET organization_id = NULL WHERE id = 'some-id'`
   - Or delete an organization that has profiles

2. **Verify in UI**:
   - Navigate to "My Profiles" page
   - Orphaned profile should show with orange border and warning
   - Click "Delete Profile" button
   - Confirm deletion
   - Profile should disappear from list

3. **Test validation**:
   - Try to create/update profile with invalid organization_id
   - Should receive 400 error with validation message

## Migration Guide

### For Existing Databases

If you have existing orphaned profiles, you have two options:

#### Option 1: Clean Up Orphaned Profiles (Recommended)
```sql
-- Find orphaned profiles
SELECT id, display_name, organization_id 
FROM profiles 
WHERE organization_id IS NULL 
   OR organization_id NOT IN (SELECT id FROM organizations);

-- Delete them
DELETE FROM profiles 
WHERE organization_id IS NULL 
   OR organization_id NOT IN (SELECT id FROM organizations);
```

#### Option 2: Fix by Linking to Organizations
```sql
-- Create a default organization for orphaned profiles
INSERT INTO organizations (name, email) 
VALUES ('Unassigned', 'unassigned@grantflow.app');

-- Link orphaned profiles to it
UPDATE profiles 
SET organization_id = (SELECT id FROM organizations WHERE name = 'Unassigned')
WHERE organization_id IS NULL;
```

## Security Considerations

1. **Authorization**: 
   - Non-admin users can only delete their own profiles
   - Prevents unauthorized deletion of other users' data

2. **Validation**:
   - Organization references are validated before profile creation/update
   - Prevents creation of invalid relationships

3. **Cleanup**:
   - Avatar files are properly deleted when profile is deleted
   - Prevents disk space leaks

## Future Improvements

1. **Bulk Actions**: Add ability to delete multiple orphaned profiles at once
2. **Auto-Repair**: Automatically link orphaned profiles to a default organization
3. **Admin Dashboard**: Provide admin view to manage all orphaned profiles across users
4. **Audit Trail**: Log profile deletions for compliance
5. **Soft Delete**: Consider soft-delete pattern for profile recovery

## Related Files

### Frontend
- `src/components/profiles/ProfileCard.jsx` - Profile card with orphan detection
- `src/pages/MyProfiles.jsx` - My Profiles page with delete dialog
- `src/api/profiles.js` - API client methods

### Backend
- `backend/routes/profiles.js` - Profile API endpoints
- `backend/db/schema.sql` - Database schema

### Tests
- `scripts/test-orphaned-profiles.mjs` - Unit tests for orphan logic
- `scripts/test-profiles-api.mjs` - Integration tests for API

## Support

For issues or questions:
- Check the GitHub issue tracker
- Review test scripts for examples
- Contact: buckeye7066@gmail.com
