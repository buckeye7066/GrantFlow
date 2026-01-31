export default async function ensureUserPreferencesTable(db) {
  if (db?.dialect === 'postgres') {
    // Postgres environments are ideally migrated deterministically via SQL migrations, but
    // production stability requires that the app can self-heal when the table is missing.
    // This is idempotent and safe to run on every request.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        sidebar_position TEXT DEFAULT 'left',
        sidebar_collapsed BOOLEAN DEFAULT FALSE,
        dashboard_layout TEXT DEFAULT 'grid',
        card_density TEXT DEFAULT 'comfortable',
        table_row_density TEXT DEFAULT 'medium',
        theme TEXT DEFAULT 'system',
        accent_color TEXT DEFAULT 'blue',
        sidebar_color_scheme TEXT DEFAULT 'default',
        high_contrast BOOLEAN DEFAULT FALSE,
        default_landing_page TEXT DEFAULT '/Dashboard',
        items_per_page INTEGER DEFAULT 25,
        date_format TEXT DEFAULT 'MM/DD/YYYY',
        currency_display TEXT DEFAULT 'USD',
        timezone TEXT DEFAULT 'America/New_York',
        email_notifications BOOLEAN DEFAULT TRUE,
        grant_deadline_reminder_days INTEGER DEFAULT 7,
        weekly_digest BOOLEAN DEFAULT TRUE,
        browser_notifications BOOLEAN DEFAULT FALSE,
        font_size TEXT DEFAULT 'medium',
        reduce_motion BOOLEAN DEFAULT FALSE,
        screen_reader_optimized BOOLEAN DEFAULT FALSE,
        custom_preferences JSONB DEFAULT '{}'::jsonb
      );
    `)
    return
  }

  const columns = db.prepare(`PRAGMA table_info(user_preferences)`).all()
  const expectedColumns = [
    'id',
    'created_at',
    'updated_at',
    'user_id',
    'sidebar_position',
    'sidebar_collapsed',
    'dashboard_layout',
    'card_density',
    'table_row_density',
    'theme',
    'accent_color',
    'sidebar_color_scheme',
    'high_contrast',
    'default_landing_page',
    'items_per_page',
    'date_format',
    'currency_display',
    'timezone',
    'email_notifications',
    'grant_deadline_reminder_days',
    'weekly_digest',
    'browser_notifications',
    'font_size',
    'reduce_motion',
    'screen_reader_optimized',
    'custom_preferences',
  ]

  const hasAllColumns = columns.length > 0 && expectedColumns.every((name) => columns.some((col) => col.name === name))

  if (hasAllColumns) {
    return
  }

  const legacyRows = columns.length > 0 ? db.prepare(`SELECT * FROM user_preferences`).all() : []

  const rebuild = async (rows) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences_new (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        sidebar_position TEXT DEFAULT 'left',
        sidebar_collapsed INTEGER DEFAULT 0,
        dashboard_layout TEXT DEFAULT 'grid',
        card_density TEXT DEFAULT 'comfortable',
        table_row_density TEXT DEFAULT 'medium',
        theme TEXT DEFAULT 'system',
        accent_color TEXT DEFAULT 'blue',
        sidebar_color_scheme TEXT DEFAULT 'default',
        high_contrast INTEGER DEFAULT 0,
        default_landing_page TEXT DEFAULT '/Dashboard',
        items_per_page INTEGER DEFAULT 25,
        date_format TEXT DEFAULT 'MM/DD/YYYY',
        currency_display TEXT DEFAULT 'USD',
        timezone TEXT DEFAULT 'America/New_York',
        email_notifications INTEGER DEFAULT 1,
        grant_deadline_reminder_days INTEGER DEFAULT 7,
        weekly_digest INTEGER DEFAULT 1,
        browser_notifications INTEGER DEFAULT 0,
        font_size TEXT DEFAULT 'medium',
        reduce_motion INTEGER DEFAULT 0,
        screen_reader_optimized INTEGER DEFAULT 0,
        custom_preferences TEXT DEFAULT '{}'
      );
    `)

    if (rows.length > 0) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO user_preferences_new (
          id,
          created_at,
          updated_at,
          user_id,
          sidebar_position,
          sidebar_collapsed,
          dashboard_layout,
          card_density,
          table_row_density,
          theme,
          accent_color,
          sidebar_color_scheme,
          high_contrast,
          default_landing_page,
          items_per_page,
          date_format,
          currency_display,
          timezone,
          email_notifications,
          grant_deadline_reminder_days,
          weekly_digest,
          browser_notifications,
          font_size,
          reduce_motion,
          screen_reader_optimized,
          custom_preferences
        ) VALUES (
          @id,
          @created_at,
          @updated_at,
          @user_id,
          'left',
          0,
          'grid',
          'comfortable',
          'medium',
          'system',
          'blue',
          'default',
          0,
          '/Dashboard',
          25,
          'MM/DD/YYYY',
          'USD',
          'America/New_York',
          1,
          7,
          1,
          0,
          'medium',
          0,
          0,
          COALESCE(@preferences_json, '{}')
        )
      `)

      rows.forEach((row) => {
        insert.run(row)
      })
    }

    await db.exec(`DROP TABLE IF EXISTS user_preferences`)
    await db.exec(`ALTER TABLE user_preferences_new RENAME TO user_preferences`)
  }

  await db.withTransaction(() => rebuild(legacyRows))
}
