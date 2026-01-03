#!/usr/bin/env node

import Database from 'better-sqlite3'
import ensureDesignatedProfiles from '../backend/utils/ensureDesignatedProfiles.js'
import { DESIGNATED_PROFILES } from '../backend/config/designatedProfiles.js'

const db = new Database('backend/data/grantflow.db')
ensureDesignatedProfiles(db)
db.close()

console.log('[sync] Profiles upserted:', DESIGNATED_PROFILES.map((p) => p.id).join(', '))
