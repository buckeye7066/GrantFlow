#!/usr/bin/env node

import path from 'path'
import Database from 'better-sqlite3'
import ensureDesignatedProfiles from '../backend/utils/ensureDesignatedProfiles.js'
import { DESIGNATED_PROFILES } from '../backend/config/designatedProfiles.js'

const dbPath = path.resolve('backend/data/grantflow.db')
const db = new Database(dbPath)
ensureDesignatedProfiles(db)
db.close()

console.log('[sync] Profiles upserted:', DESIGNATED_PROFILES.map((p) => p.id).join(', '))
