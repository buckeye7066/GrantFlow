/**
 * verify-pg-schema.mjs
 *
 * Read-only post-migration assertions for PostgreSQL. Run after `npm run
 * migrate` against a freshly migrated database and against the intended
 * release database before application traffic is admitted.
 *
 * Requires DATABASE_URL (+ DB_PROVIDER=postgres). The verifier never changes
 * schema or data; it exits non-zero when a release-critical contract differs.
 */

import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  APPLICATION_TASK_STATUSES,
} from '../db/migrations/163_hamilton_submission_attempt_states.mjs'

export const REQUIRED_TABLES = Object.freeze([
  'grants',
  'funding_opportunities',
  'grant_applications',
  'profiles',
  'user_sessions',
  'auth_refresh_token_history',
  'application_tasks',
  'hamilton_manual_submission_receipts',
])

// `nullable` and `defaultValue` are asserted only where they carry release
// semantics. PostgreSQL reports text defaults in the canonical `'x'::text`
// form, so default checks are normalized before comparison.
export const COLUMN_EXPECTATIONS = Object.freeze([
  // Existing canonical JSON/text contracts.
  { table: 'grants', column: 'match_explanation', type: 'text' },
  { table: 'grants', column: 'match_reasons', type: 'text' },
  { table: 'grants', column: 'matched_needs', type: 'jsonb' },

  // SQLite migration 036 parity: authoritative persisted grant decision.
  { table: 'grants', column: 'eligibility_status', type: 'text' },
  {
    table: 'grants',
    column: 'ineligibility_reasons',
    type: 'text',
    defaultValue: "'[]'::text",
  },
  { table: 'grants', column: 'evaluated_at', type: 'timestamp with time zone' },
  { table: 'grants', column: 'match_confidence', type: 'integer' },

  // funding_opportunities boolean and normalized-match contracts.
  { table: 'funding_opportunities', column: 'is_active', type: 'boolean' },
  { table: 'funding_opportunities', column: 'is_national', type: 'boolean' },
  { table: 'funding_opportunities', column: 'is_loan', type: 'boolean' },
  { table: 'funding_opportunities', column: 'requires_match', type: 'boolean' },
  {
    table: 'funding_opportunities',
    column: 'entity_types_allowed',
    type: 'text',
    defaultValue: "'[]'::text",
  },
  {
    table: 'funding_opportunities',
    column: 'need_types_supported',
    type: 'text',
    defaultValue: "'[]'::text",
  },
  { table: 'funding_opportunities', column: 'deadline_status', type: 'text' },
  { table: 'funding_opportunities', column: 'official_source_type', type: 'text' },
  { table: 'funding_opportunities', column: 'source_trust_score', type: 'integer' },
  { table: 'funding_opportunities', column: 'opportunity_fingerprint', type: 'text' },

  // Cached inputs used to decide whether persisted match output is stale.
  { table: 'profiles', column: 'profile_fingerprint', type: 'text' },
  { table: 'profiles', column: 'normalized_snapshot', type: 'text' },

  // Refresh-token replay history must retain real timezone-aware instants.
  {
    table: 'auth_refresh_token_history',
    column: 'token_hash',
    type: 'text',
    nullable: false,
  },
  {
    table: 'auth_refresh_token_history',
    column: 'session_id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'auth_refresh_token_history',
    column: 'replaced_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
  {
    table: 'auth_refresh_token_history',
    column: 'expires_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
  {
    table: 'auth_refresh_token_history',
    column: 'reuse_detected_at',
    type: 'timestamp with time zone',
    nullable: true,
  },

  // Manual submission evidence is release-critical. The bytes must remain in
  // PostgreSQL (not an ephemeral filesystem), while the binding retains an
  // immutable hash/fingerprint and timezone-aware owner attestation.
  { table: 'documents', column: 'file_bytes', type: 'bytea' },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'task_id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'profile_id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'document_id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'channel',
    type: 'text',
    nullable: false,
    defaultValue: "'portal_manual'::text",
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'portal_origin',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'portal_target_sha256',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'task_identity_sha256',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'confirmation_reference',
    type: 'text',
    nullable: true,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'submitted_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'attestation_version',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'attested_by_user_id',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'attested_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'receipt_sha256',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'file_size',
    type: 'integer',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'mime_type',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'idempotency_key',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'request_fingerprint',
    type: 'text',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'status',
    type: 'text',
    nullable: false,
    defaultValue: "'active'::text",
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'revoked_at',
    type: 'timestamp with time zone',
    nullable: true,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'revoked_by_user_id',
    type: 'text',
    nullable: true,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'revocation_reason',
    type: 'text',
    nullable: true,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'created_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
  {
    table: 'hamilton_manual_submission_receipts',
    column: 'updated_at',
    type: 'timestamp with time zone',
    nullable: false,
  },
])

export const REQUIRED_INDEXES = Object.freeze([
  {
    table: 'auth_refresh_token_history',
    name: 'idx_auth_refresh_history_session',
    column: 'session_id',
  },
  {
    table: 'auth_refresh_token_history',
    name: 'idx_auth_refresh_history_expires',
    column: 'expires_at',
  },
])

export const RECEIPT_KEY_EXPECTATIONS = Object.freeze([
  { type: 'PRIMARY KEY', columns: Object.freeze(['id']) },
  { type: 'UNIQUE', columns: Object.freeze(['document_id']) },
  { type: 'UNIQUE', columns: Object.freeze(['task_id', 'idempotency_key']) },
])

export const RECEIPT_FOREIGN_KEY_EXPECTATIONS = Object.freeze([
  { column: 'task_id', foreignTable: 'application_tasks', foreignColumn: 'id' },
  { column: 'profile_id', foreignTable: 'profiles', foreignColumn: 'id' },
  { column: 'document_id', foreignTable: 'documents', foreignColumn: 'id' },
])

export const RECEIPT_ENUM_EXPECTATIONS = Object.freeze([
  { column: 'channel', values: Object.freeze(['portal_manual']) },
  {
    column: 'mime_type',
    values: Object.freeze(['application/pdf', 'image/jpeg', 'image/png']),
  },
  { column: 'status', values: Object.freeze(['active', 'revoked']) },
])

export const RECEIPT_TRIGGER_EXPECTATIONS = Object.freeze([
  {
    table: 'documents',
    name: 'trg_hamilton_manual_receipt_document_immutable',
    triggerTerms: Object.freeze(['before', 'update', 'file_bytes', 'content_hash']),
    functionTerms: Object.freeze([
      'fromhamilton_manual_submission_receipts',
      'new.file_bytesisdistinctfromold.file_bytes',
      'new.content_hashisdistinctfromold.content_hash',
      "raiseexception'manualsubmissionreceiptevidenceisimmutable'",
    ]),
  },
  {
    table: 'hamilton_manual_submission_receipts',
    name: 'trg_hamilton_manual_receipt_binding_append_only',
    triggerTerms: Object.freeze(['before', 'update', 'delete']),
    functionTerms: Object.freeze([
      "tg_op='delete'",
      "old.status='revoked'",
      "new.status<>'revoked'",
      'new.revoked_atisnull',
      'new.revoked_by_user_idisnull',
      'new.revocation_reasonisnull',
      'new.task_idisdistinctfromold.task_id',
      'new.portal_target_sha256isdistinctfromold.portal_target_sha256',
      'new.task_identity_sha256isdistinctfromold.task_identity_sha256',
      'new.request_fingerprintisdistinctfromold.request_fingerprint',
      "raiseexception'manualsubmissionreceiptbindingsareappend-only'",
    ]),
  },
  {
    table: 'application_tasks',
    name: 'trg_hamilton_manual_receipt_task_identity',
    triggerTerms: Object.freeze([
      'before',
      'update',
      'portal_url',
      'application_url',
      'submitted_at',
      'completed_at',
      'current_step',
      'status',
      'profile_id',
      'user_id',
      'opportunity_id',
      'grant_id',
      'portal_id',
      'application_id',
      'university_application_id',
      'automation_type',
      'output_document_id',
      'output_pdf_document_id',
      'output_docx_document_id',
      'output_proposal_document_id',
      'auto_submit_enabled',
      'allow_auto_submit',
    ]),
    functionTerms: Object.freeze([
      'fromhamilton_manual_submission_receipts',
      "status='active'",
      'new.statusisdistinctfromold.status',
      'new.portal_urlisdistinctfromold.portal_url',
      'new.application_urlisdistinctfromold.application_url',
      'new.submitted_atisdistinctfromold.submitted_at',
      'new.completed_atisdistinctfromold.completed_at',
      'new.current_stepisdistinctfromold.current_step',
      'new.output_document_idisdistinctfromold.output_document_id',
      'new.output_pdf_document_idisdistinctfromold.output_pdf_document_id',
      'new.output_docx_document_idisdistinctfromold.output_docx_document_id',
      'new.output_proposal_document_idisdistinctfromold.output_proposal_document_id',
      'new.user_idisdistinctfromold.user_id',
      'new.profile_idisdistinctfromold.profile_id',
      'new.opportunity_idisdistinctfromold.opportunity_id',
      'new.grant_idisdistinctfromold.grant_id',
      'new.portal_idisdistinctfromold.portal_id',
      'new.application_idisdistinctfromold.application_id',
      'new.university_application_idisdistinctfromold.university_application_id',
      'new.automation_typeisdistinctfromold.automation_type',
      'new.auto_submit_enabledisdistinctfromold.auto_submit_enabled',
      'new.allow_auto_submitisdistinctfromold.allow_auto_submit',
      "raiseexception'activemanualsubmissionreceiptlockstaskidentity'",
    ]),
  },
])

function normalizeSqlFragment(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase()
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compactCatalogSql(value) {
  return String(value ?? '').replace(/[\s"();]+/g, '').toLowerCase()
}

function constraintColumns(row) {
  if (Array.isArray(row?.columns)) return row.columns.map(String)
  try {
    const parsed = JSON.parse(String(row?.columns_json ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function definitionReferencesColumn(definition, column) {
  const escaped = String(column).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9_])"?${escaped}"?(?:[^a-z0-9_]|$)`, 'i')
    .test(String(definition ?? ''))
}

export function extractStatusConstraintValues(definition) {
  const values = []
  const quotedLiteral = /'((?:''|[^'])*)'(?:\s*::\s*(?:text|character varying))?/gi
  for (const match of String(definition || '').matchAll(quotedLiteral)) {
    values.push(match[1].replace(/''/g, "'"))
  }
  return [...new Set(values)].sort()
}

export function indexCoversOnlyColumn(indexDefinition, column) {
  const escaped = String(column).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `\\(\\s*"?${escaped}"?\\s*(?:ASC|DESC)?\\s*\\)(?:\\s*WHERE\\s+.+)?$`,
    'i',
  )
  return pattern.test(String(indexDefinition || '').trim())
}

async function requireTables(db, failures) {
  for (const table of REQUIRED_TABLES) {
    const row = await db.prepare(`
      SELECT 1 AS present
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ?
      LIMIT 1
    `).get(table)
    if (!row) failures.push(`missing table: ${table}`)
  }
}

async function requireColumns(db, failures) {
  for (const expectation of COLUMN_EXPECTATIONS) {
    const { table, column, type, nullable, defaultValue } = expectation
    const row = await db.prepare(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ?
        AND column_name = ?
    `).get(table, column)

    if (!row) {
      failures.push(`missing column: ${table}.${column} (expected ${type})`)
      continue
    }
    if (String(row.data_type).toLowerCase() !== type) {
      failures.push(`${table}.${column} is ${row.data_type}, expected ${type}`)
    }
    if (nullable !== undefined) {
      const actualNullable = String(row.is_nullable).toUpperCase() === 'YES'
      if (actualNullable !== nullable) {
        failures.push(
          `${table}.${column} nullable=${actualNullable}, expected nullable=${nullable}`,
        )
      }
    }
    if (
      defaultValue !== undefined
      && normalizeSqlFragment(row.column_default) !== normalizeSqlFragment(defaultValue)
    ) {
      failures.push(
        `${table}.${column} default is ${row.column_default ?? 'NULL'}, expected ${defaultValue}`,
      )
    }
  }
}

async function requireRefreshHistoryKey(db, failures) {
  const primaryKeyRows = await db.prepare(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
     AND kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'auth_refresh_token_history'
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `).all()
  const primaryKeyColumns = primaryKeyRows.map((row) => row.column_name)
  if (!arraysEqual(primaryKeyColumns, ['token_hash'])) {
    failures.push(
      `auth_refresh_token_history primary key is [${primaryKeyColumns.join(', ')}], expected [token_hash]`,
    )
  }

  const foreignKey = await db.prepare(`
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
     AND kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_catalog = tc.constraint_catalog
     AND rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_catalog = rc.unique_constraint_catalog
     AND ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'auth_refresh_token_history'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'session_id'
    LIMIT 1
  `).get()

  if (!foreignKey) {
    failures.push('missing foreign key: auth_refresh_token_history.session_id')
    return
  }
  if (
    foreignKey.foreign_table_name !== 'user_sessions'
    || foreignKey.foreign_column_name !== 'id'
    || String(foreignKey.delete_rule).toUpperCase() !== 'CASCADE'
  ) {
    failures.push(
      'auth_refresh_token_history.session_id must reference user_sessions.id ON DELETE CASCADE',
    )
  }
}

async function requireIndexes(db, failures) {
  for (const expectation of REQUIRED_INDEXES) {
    const row = await db.prepare(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ?
        AND indexname = ?
    `).get(expectation.table, expectation.name)
    if (!row) {
      failures.push(`missing index: ${expectation.name}`)
      continue
    }
    if (!indexCoversOnlyColumn(row.indexdef, expectation.column)) {
      failures.push(
        `${expectation.name} must index only ${expectation.table}.${expectation.column}`,
      )
    }
  }
}

async function requireReceiptKeys(db, failures) {
  const rows = await db.prepare(`
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      json_agg(kcu.column_name ORDER BY kcu.ordinal_position)::text AS columns_json
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
     AND kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'hamilton_manual_submission_receipts'
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    GROUP BY tc.constraint_name, tc.constraint_type
  `).all()

  for (const expectation of RECEIPT_KEY_EXPECTATIONS) {
    const found = rows.some((row) => (
      String(row.constraint_type).toUpperCase() === expectation.type
      && arraysEqual(constraintColumns(row), expectation.columns)
    ))
    if (!found) {
      failures.push(
        `missing ${expectation.type.toLowerCase()}: hamilton_manual_submission_receipts(${expectation.columns.join(', ')})`,
      )
    }
  }
}

async function requireReceiptForeignKeys(db, failures) {
  const rows = await db.prepare(`
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
     AND kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_catalog = tc.constraint_catalog
     AND rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_catalog = rc.unique_constraint_catalog
     AND ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'hamilton_manual_submission_receipts'
      AND tc.constraint_type = 'FOREIGN KEY'
  `).all()

  for (const expectation of RECEIPT_FOREIGN_KEY_EXPECTATIONS) {
    const row = rows.find((candidate) => candidate.column_name === expectation.column)
    if (!row) {
      failures.push(
        `missing foreign key: hamilton_manual_submission_receipts.${expectation.column}`,
      )
      continue
    }
    if (
      row.foreign_table_name !== expectation.foreignTable
      || row.foreign_column_name !== expectation.foreignColumn
      || String(row.delete_rule).toUpperCase() !== 'RESTRICT'
    ) {
      failures.push(
        `hamilton_manual_submission_receipts.${expectation.column} must reference ${expectation.foreignTable}.${expectation.foreignColumn} ON DELETE RESTRICT`,
      )
    }
  }
}

async function requireReceiptActiveTaskIndex(db, failures) {
  const indexName = 'ux_hamilton_manual_receipt_active_task'
  const row = await db.prepare(`
    SELECT
      catalog_index.indexdef,
      physical_index.indisvalid AS valid,
      physical_index.indisready AS ready
    FROM pg_indexes catalog_index
    JOIN pg_class index_relation
      ON index_relation.relname = catalog_index.indexname
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
     AND index_namespace.nspname = catalog_index.schemaname
    JOIN pg_index physical_index
      ON physical_index.indexrelid = index_relation.oid
    WHERE catalog_index.schemaname = current_schema()
      AND catalog_index.tablename = 'hamilton_manual_submission_receipts'
      AND catalog_index.indexname = ?
  `).get(indexName)

  if (!row) {
    failures.push(`missing index: ${indexName}`)
    return
  }

  const definition = String(row.indexdef ?? '')
  const activePredicate = /\bwhere\s+\(?\s*"?status"?\s*=\s*'active'(?:\s*::\s*text)?\s*\)?\s*$/i
  if (
    row.valid !== true
    || row.ready !== true
    || !/^\s*create\s+unique\s+index\b/i.test(definition)
    || !indexCoversOnlyColumn(definition, 'task_id')
    || !activePredicate.test(definition)
  ) {
    failures.push(
      `${indexName} must be a unique task_id index restricted to status = 'active'`,
    )
  }
}

async function requireReceiptCheckConstraints(db, failures) {
  const rows = await db.prepare(`
    SELECT
      c.conname AS name,
      pg_get_constraintdef(c.oid) AS definition,
      c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'hamilton_manual_submission_receipts'
      AND c.contype = 'c'
  `).all()

  for (const expectation of RECEIPT_ENUM_EXPECTATIONS) {
    const row = rows.find((candidate) => (
      definitionReferencesColumn(candidate.definition, expectation.column)
    ))
    if (!row) {
      failures.push(
        `missing check constraint: hamilton_manual_submission_receipts.${expectation.column}`,
      )
      continue
    }
    if (row.validated !== true) {
      failures.push(
        `hamilton_manual_submission_receipts.${expectation.column} check is NOT VALID`,
      )
    }
    const actualValues = extractStatusConstraintValues(row.definition)
    const expectedValues = [...expectation.values].sort()
    if (!arraysEqual(actualValues, expectedValues)) {
      failures.push(
        `hamilton_manual_submission_receipts.${expectation.column} check drift (expected: ${expectedValues.join(', ')}; actual: ${actualValues.join(', ') || 'none'})`,
      )
    }
  }

  const scalarExpectations = [
    { column: 'receipt_sha256', terms: ['lengthreceipt_sha256=64'] },
    { column: 'portal_target_sha256', terms: ['lengthportal_target_sha256=64'] },
    { column: 'task_identity_sha256', terms: ['lengthtask_identity_sha256=64'] },
    { column: 'request_fingerprint', terms: ['lengthrequest_fingerprint=64'] },
    { column: 'file_size', terms: ['file_size>0', 'file_size<=10485760'] },
  ]
  for (const expectation of scalarExpectations) {
    const found = rows.some((row) => {
      if (!definitionReferencesColumn(row.definition, expectation.column)) return false
      const compact = compactCatalogSql(row.definition)
      return row.validated === true
        && expectation.terms.every((term) => compact.includes(term))
    })
    if (!found) {
      failures.push(
        `missing validated bounds check: hamilton_manual_submission_receipts.${expectation.column}`,
      )
    }
  }
}

async function requireReceiptTriggers(db, failures) {
  for (const expectation of RECEIPT_TRIGGER_EXPECTATIONS) {
    const row = await db.prepare(`
      SELECT
        tg.tgenabled AS enabled,
        pg_get_triggerdef(tg.oid, true) AS definition,
        pg_get_functiondef(p.oid) AS function_definition
      FROM pg_trigger tg
      JOIN pg_class t ON t.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE n.nspname = current_schema()
        AND t.relname = ?
        AND tg.tgname = ?
        AND NOT tg.tgisinternal
      LIMIT 1
    `).get(expectation.table, expectation.name)

    if (!row) {
      failures.push(`missing trigger: ${expectation.name} on ${expectation.table}`)
      continue
    }
    if (!['O', 'A'].includes(String(row.enabled).toUpperCase())) {
      failures.push(`${expectation.name} is not enabled for ordinary writes`)
    }

    const triggerDefinition = String(row.definition ?? '').toLowerCase()
    const missingTriggerTerms = expectation.triggerTerms.filter(
      (term) => !triggerDefinition.includes(term),
    )
    if (missingTriggerTerms.length > 0) {
      failures.push(
        `${expectation.name} trigger definition drift (missing: ${missingTriggerTerms.join(', ')})`,
      )
    }

    const functionDefinition = compactCatalogSql(row.function_definition)
    const missingFunctionTerms = expectation.functionTerms.filter(
      (term) => !functionDefinition.includes(term),
    )
    if (missingFunctionTerms.length > 0) {
      failures.push(
        `${expectation.name} function definition drift (missing ${missingFunctionTerms.length} required term${missingFunctionTerms.length === 1 ? '' : 's'})`,
      )
    }
  }
}

async function requireHamiltonStatusConstraint(db, failures) {
  const row = await db.prepare(`
    SELECT
      pg_get_constraintdef(c.oid) AS definition,
      c.convalidated AS validated
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'application_tasks'
      AND c.conname = 'application_tasks_status_check'
      AND c.contype = 'c'
    LIMIT 1
  `).get()

  if (!row) {
    failures.push('missing constraint: application_tasks_status_check')
    return
  }
  if (row.validated !== true) {
    failures.push('application_tasks_status_check is NOT VALID')
  }

  const actualStatuses = extractStatusConstraintValues(row.definition)
  const expectedStatuses = [...APPLICATION_TASK_STATUSES].sort()
  if (!arraysEqual(actualStatuses, expectedStatuses)) {
    const missing = expectedStatuses.filter((status) => !actualStatuses.includes(status))
    const extra = actualStatuses.filter((status) => !expectedStatuses.includes(status))
    failures.push(
      `application_tasks_status_check state drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    )
  }
}

export async function verifyPgSchema(db) {
  if (db?.dialect !== 'postgres') {
    return {
      failures: [`expected a postgres DB, got dialect=${db?.dialect ?? 'unknown'}`],
      wrongDialect: true,
    }
  }

  const failures = []
  await requireTables(db, failures)
  await requireColumns(db, failures)
  await requireRefreshHistoryKey(db, failures)
  await requireIndexes(db, failures)
  await requireHamiltonStatusConstraint(db, failures)
  await requireReceiptKeys(db, failures)
  await requireReceiptForeignKeys(db, failures)
  await requireReceiptActiveTaskIndex(db, failures)
  await requireReceiptCheckConstraints(db, failures)
  await requireReceiptTriggers(db, failures)
  return { failures, wrongDialect: false }
}

async function runCli() {
  const { getDb } = await import('../db/index.js')
  const db = getDb()
  try {
    const result = await verifyPgSchema(db)
    if (result.failures.length > 0) {
      console.error('[verify-pg-schema] FAILED:')
      for (const failure of result.failures) console.error(`  - ${failure}`)
      return result.wrongDialect ? 2 : 1
    }

    console.log(
      `[verify-pg-schema] OK — ${REQUIRED_TABLES.length} tables, ${COLUMN_EXPECTATIONS.length} columns, ${REQUIRED_INDEXES.length + 1} named indexes, ${RECEIPT_KEY_EXPECTATIONS.length} receipt key constraints, ${RECEIPT_FOREIGN_KEY_EXPECTATIONS.length} receipt foreign keys, ${RECEIPT_ENUM_EXPECTATIONS.length + 5} receipt checks, ${RECEIPT_TRIGGER_EXPECTATIONS.length} receipt triggers, and ${APPLICATION_TASK_STATUSES.length} Hamilton states match the canonical PostgreSQL schema.`,
    )
    return 0
  } finally {
    await db.close()
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  runCli()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      console.error('[verify-pg-schema] ERROR:', error?.message || error)
      process.exitCode = 1
    })
}
