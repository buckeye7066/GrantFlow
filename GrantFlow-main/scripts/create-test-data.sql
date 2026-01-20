-- Create test opportunities if none exist
INSERT OR IGNORE INTO funding_opportunities (
  id, title, description, sponsor, amount, deadline, 
  eligibility_bullets, is_active, created_at
) VALUES 
  ('test-opp-1', 'Test Community Grant', 'Grant for community organizations', 
   'Test Foundation', '10000', date('now', '+30 days'), 
   '["Nonprofit organizations", "Community focus"]', 1, datetime('now')),
  ('test-opp-2', 'Test Education Grant', 'Support for educational programs',
   'Education Fund', '25000', date('now', '+60 days'),
   '["Schools", "Educational nonprofits"]', 1, datetime('now'));

-- Ensure test profile exists
INSERT OR IGNORE INTO profiles (
  id, display_name, primary_type, created_at
) VALUES 
  ('test-profile-1', 'Test Organization', 'nonprofit', datetime('now'));
