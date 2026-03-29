-- User Preferences Table
-- Stores user-specific UI and application preferences

CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Layout Options
  sidebar_position TEXT DEFAULT 'left' CHECK(sidebar_position IN ('left', 'right')),
  sidebar_collapsed BOOLEAN DEFAULT 0,
  dashboard_layout TEXT DEFAULT 'grid' CHECK(dashboard_layout IN ('grid', 'list')),
  card_density TEXT DEFAULT 'comfortable' CHECK(card_density IN ('compact', 'comfortable', 'spacious')),
  table_row_density TEXT DEFAULT 'medium' CHECK(table_row_density IN ('compact', 'medium', 'spacious')),
  
  -- Theme Options
  theme TEXT DEFAULT 'system' CHECK(theme IN ('light', 'dark', 'system')),
  accent_color TEXT DEFAULT 'blue',
  sidebar_color_scheme TEXT DEFAULT 'default',
  high_contrast BOOLEAN DEFAULT 0,
  
  -- Display Preferences
  default_landing_page TEXT DEFAULT '/Dashboard',
  items_per_page INTEGER DEFAULT 25 CHECK(items_per_page IN (10, 25, 50, 100)),
  date_format TEXT DEFAULT 'MM/DD/YYYY' CHECK(date_format IN ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD')),
  currency_display TEXT DEFAULT 'USD',
  timezone TEXT DEFAULT 'America/New_York',
  
  -- Notification Preferences
  email_notifications BOOLEAN DEFAULT 1,
  grant_deadline_reminder_days INTEGER DEFAULT 7,
  weekly_digest BOOLEAN DEFAULT 1,
  browser_notifications BOOLEAN DEFAULT 0,
  
  -- Accessibility Options
  font_size TEXT DEFAULT 'medium' CHECK(font_size IN ('small', 'medium', 'large')),
  reduce_motion BOOLEAN DEFAULT 0,
  screen_reader_optimized BOOLEAN DEFAULT 0,
  
  -- Additional preferences stored as JSON
  custom_preferences TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

CREATE TRIGGER IF NOT EXISTS update_user_preferences_timestamp
AFTER UPDATE ON user_preferences
BEGIN
  UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
