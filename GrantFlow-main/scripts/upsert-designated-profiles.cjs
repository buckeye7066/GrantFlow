#!/usr/bin/env node

const path = require('path')
const Database = require('better-sqlite3')

const configPath = path.resolve(__dirname, '../backend/config/designatedProfiles.js')
// eslint-disable-next-line import/no-dynamic-require, global-require
const config = require(configPath)
const DESIGNATED_PROFILES = config.DESIGNATED_PROFILES || config.default?.DESIGNATED_PROFILES || []

const utilsPath = path.resolve(__dirname, '../backend/utils/ensureDesignatedProfiles.js')
const utils = require(utilsPath)
const ensureDesignatedProfiles =
  utils.ensureDesignatedProfiles || utils.default || utils

const db = new Database(path.resolve(__dirname, '../backend/data/grantflow.db'))
ensureDesignatedProfiles(db)
db.close()

console.log('[sync] Profiles upserted:', DESIGNATED_PROFILES.map((p) => p.id).join(', '))
