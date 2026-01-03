# User-Profile Mapping Configuration

## Overview
This system allows specific users to be automatically assigned to designated profiles when they sign up or log in via email authentication.

## How It Works
1. When a user signs up with email, the system checks if their email is in the `USER_PROFILE_MAPPINGS` configuration
2. If a mapping exists, the user is assigned to their designated profile
3. If no mapping exists, the user is assigned to the first available unlinked profile

## Adding User Mappings

### Step 1: Find Profile IDs
Profile IDs can be found in:
- The `seed/baseline-profiles.json` file
- The database `profiles` table: `SELECT id, display_name FROM profiles;`
- The admin UI when viewing profiles

### Step 2: Update the Configuration
Edit `backend/config/userProfileMappings.js` and add entries to the `USER_PROFILE_MAPPINGS` object:

```javascript
export const USER_PROFILE_MAPPINGS = {
  'user@example.com': 'profile-id-from-database',
  
  // Example with actual users:
  'brian@example.com': 'profile-axiom-community-health',
  'avanell@example.com': 'profile-bright-trails-youth',
  'olivia@example.com': 'profile-camila-ortiz',
  'hollie@example.com': 'profile-harper-family-support',
}
```

### Step 3: Restart the Server
After updating the configuration, restart the backend server for changes to take effect.

## Current Mappings Required

The following users need their email addresses and profile IDs added:

1. **Brian** - Email: `?` - Profile ID: `?`
2. **Avanell** - Email: `?` - Profile ID: `?`
3. **Olivia** - Email: `?` - Profile ID: `?`
4. **Hollie** - Email: `?` - Profile ID: `?`

**To complete the setup:**
1. Get the email addresses for these four users
2. Determine which profile each user should be assigned to
3. Update `backend/config/userProfileMappings.js` with the mappings
4. Restart the backend server

## Available Profiles (from baseline-profiles.json)

- `profile-axiom-community-health` - Axiom Community Health Cooperative
- `profile-bright-trails-youth` - Bright Trails Youth Services
- `profile-riverbend-veteran-housing` - Riverbend Veteran Housing Initiative
- `profile-harper-family-support` - Harper Family Support Fund
- `profile-northside-robotics` - Northside Robotics Scholars
- `profile-camila-ortiz` - Camila Ortiz
- `profile-summit-adaptive-sports` - Summit Adaptive Sports Alliance
- `profile-oak-street-early-learning` - Oak Street Early Learning Center
- `profile-sierra-tribal-artisans` - Sierra Tribal Artisans Collaborative
- Plus 2 more from the baseline set

## Authentication Method

**Email-only authentication** is configured in `src/pages/Login.jsx`:
```javascript
const AUTH_TABS = new Set(['email'])
```

This ensures users can only authenticate via email, not phone or social login.

## Testing

To verify the mapping works:
1. Sign up with one of the mapped email addresses
2. Check that the user is assigned to the correct profile
3. Log messages will appear in the server console confirming the assignment
