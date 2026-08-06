import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  APPLICATION_TASK_STATUS_COUNTS_SQL,
  assessApplicationTaskStatusCounts,
  preflightApplicationTaskStatuses,
} from '../../backend/scripts/preflight-pg-application-task-statuses.mjs'
import {
  COLUMN_EXPECTATIONS,
  RECEIPT_ENUM_EXPECTATIONS,
  RECEIPT_FOREIGN_KEY_EXPECTATIONS,
  RECEIPT_KEY_EXPECTATIONS,
  RECEIPT_TRIGGER_EXPECTATIONS,
  REQUIRED_TABLES,
  extractStatusConstraintValues,
  indexCoversOnlyColumn,
  verifyPgSchema,
} from '../../backend/scripts/verify-pg-schema.mjs'
import {
  APPLICATION_TASK_STATUSES,
} from '../../backend/db/migrations/163_hamilton_submission_attempt_states.mjs'

const MIGRATION_PATH = new URL(
  '../../backend/db/postgres/migrations/0168_funding_opportunity_match_semantics.sql',
  import.meta.url,
)

const RECEIPT_MIGRATION_PATH = new URL(
  '../../backend/db/postgres/migrations/0170_hamilton_manual_submission_receipts.sql',
  import.meta.url,
)

const MIGRATION_036_PARITY_COLUMNS = Object.freeze([
  ['grants', 'eligibility_status', 'TEXT'],
  ['grants', 'ineligibility_reasons', "TEXT DEFAULT '[]'"],
  ['grants', 'evaluated_at', 'TIMESTAMPTZ'],
  ['grants', 'match_confidence', 'INTEGER'],
  ['funding_opportunities', 'entity_types_allowed', "TEXT DEFAULT '[]'"],
  ['funding_opportunities', 'need_types_supported', "TEXT DEFAULT '[]'"],
  ['funding_opportunities', 'deadline_status', 'TEXT'],
  ['funding_opportunities', 'official_source_type', 'TEXT'],
  ['funding_opportunities', 'source_trust_score', 'INTEGER'],
  ['funding_opportunities', 'opportunity_fingerprint', 'TEXT'],
  ['profiles', 'profile_fingerprint', 'TEXT'],
  ['profiles', 'normalized_snapshot', 'TEXT'],
])

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const RECEIPT_KEYS = Object.freeze([
  { constraint_type: 'PRIMARY KEY', columns_json: '["id"]' },
  { constraint_type: 'UNIQUE', columns_json: '["document_id"]' },
  { constraint_type: 'UNIQUE', columns_json: '["task_id","idempotency_key"]' },
])

const RECEIPT_FOREIGN_KEYS = Object.freeze([
  {
    column_name: 'task_id',
    foreign_table_name: 'application_tasks',
    foreign_column_name: 'id',
    delete_rule: 'RESTRICT',
  },
  {
    column_name: 'profile_id',
    foreign_table_name: 'profiles',
    foreign_column_name: 'id',
    delete_rule: 'RESTRICT',
  },
  {
    column_name: 'document_id',
    foreign_table_name: 'documents',
    foreign_column_name: 'id',
    delete_rule: 'RESTRICT',
  },
])

const RECEIPT_CHECKS = Object.freeze([
  { definition: "CHECK ((channel = 'portal_manual'::text))", validated: true },
  {
    definition: "CHECK ((mime_type = ANY (ARRAY['application/pdf'::text, 'image/png'::text, 'image/jpeg'::text])))",
    validated: true,
  },
  {
    definition: "CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))",
    validated: true,
  },
  { definition: 'CHECK ((length(receipt_sha256) = 64))', validated: true },
  { definition: 'CHECK ((length(portal_target_sha256) = 64))', validated: true },
  { definition: 'CHECK ((length(task_identity_sha256) = 64))', validated: true },
  { definition: 'CHECK ((length(request_fingerprint) = 64))', validated: true },
  {
    definition: 'CHECK (((file_size > 0) AND (file_size <= 10485760)))',
    validated: true,
  },
])

const RECEIPT_TRIGGERS = Object.freeze({
  trg_hamilton_manual_receipt_document_immutable: {
    enabled: 'O',
    definition: 'CREATE TRIGGER trg_hamilton_manual_receipt_document_immutable BEFORE UPDATE OF file_bytes, content_hash ON documents FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_document()',
    function_definition: `
      CREATE FUNCTION protect_hamilton_manual_receipt_document() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM hamilton_manual_submission_receipts WHERE document_id = OLD.id)
          AND (NEW.file_bytes IS DISTINCT FROM OLD.file_bytes
            OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
          RAISE EXCEPTION 'manual submission receipt evidence is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
  trg_hamilton_manual_receipt_binding_append_only: {
    enabled: 'O',
    definition: 'CREATE TRIGGER trg_hamilton_manual_receipt_binding_append_only BEFORE DELETE OR UPDATE ON hamilton_manual_submission_receipts FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_binding()',
    function_definition: `
      CREATE FUNCTION protect_hamilton_manual_receipt_binding() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR OLD.status = 'revoked'
          OR NEW.status <> 'revoked'
          OR NEW.revoked_at IS NULL
          OR NEW.revoked_by_user_id IS NULL
          OR NEW.revocation_reason IS NULL
          OR NEW.task_id IS DISTINCT FROM OLD.task_id
          OR NEW.portal_target_sha256 IS DISTINCT FROM OLD.portal_target_sha256
          OR NEW.task_identity_sha256 IS DISTINCT FROM OLD.task_identity_sha256
          OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
          RAISE EXCEPTION 'manual submission receipt bindings are append-only';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
  trg_hamilton_manual_receipt_task_identity: {
    enabled: 'O',
    definition: 'CREATE TRIGGER trg_hamilton_manual_receipt_task_identity BEFORE UPDATE OF user_id, profile_id, opportunity_id, grant_id, status, current_step, submitted_at, completed_at, portal_url, application_url, portal_id, application_id, university_application_id, automation_type, output_document_id, output_pdf_document_id, output_docx_document_id, output_proposal_document_id, auto_submit_enabled, allow_auto_submit ON application_tasks FOR EACH ROW EXECUTE FUNCTION protect_hamilton_manual_receipt_task_identity()',
    function_definition: `
      CREATE FUNCTION protect_hamilton_manual_receipt_task_identity() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM hamilton_manual_submission_receipts
          WHERE task_id = OLD.id AND status = 'active'
        ) AND (
          NEW.status IS DISTINCT FROM OLD.status
          OR NEW.current_step IS DISTINCT FROM OLD.current_step
          OR NEW.portal_url IS DISTINCT FROM OLD.portal_url
          OR NEW.application_url IS DISTINCT FROM OLD.application_url
          OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
          OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
          OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
          OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
          OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
          OR NEW.portal_id IS DISTINCT FROM OLD.portal_id
          OR NEW.application_id IS DISTINCT FROM OLD.application_id
          OR NEW.university_application_id IS DISTINCT FROM OLD.university_application_id
          OR NEW.automation_type IS DISTINCT FROM OLD.automation_type
          OR NEW.output_document_id IS DISTINCT FROM OLD.output_document_id
          OR NEW.output_pdf_document_id IS DISTINCT FROM OLD.output_pdf_document_id
          OR NEW.output_docx_document_id IS DISTINCT FROM OLD.output_docx_document_id
          OR NEW.output_proposal_document_id IS DISTINCT FROM OLD.output_proposal_document_id
          OR NEW.auto_submit_enabled IS DISTINCT FROM OLD.auto_submit_enabled
          OR NEW.allow_auto_submit IS DISTINCT FROM OLD.allow_auto_submit
        ) THEN
          RAISE EXCEPTION 'active manual submission receipt locks task identity';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
})

function makeSchemaDb({
  capturedSql = [],
  columnOverrides = {},
  missingTables = [],
  missingIndexes = [],
  receiptChecks = RECEIPT_CHECKS,
  receiptForeignKeys = RECEIPT_FOREIGN_KEYS,
  receiptKeys = RECEIPT_KEYS,
  statuses = APPLICATION_TASK_STATUSES,
  triggerOverrides = {},
} = {}) {
  return {
    dialect: 'postgres',
    prepare(sql) {
      capturedSql.push(String(sql))
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      return {
        async get(...args) {
          if (normalized.includes('from information_schema.tables')) {
            return missingTables.includes(args[0]) ? undefined : { present: 1 }
          }
          if (normalized.includes('from information_schema.columns')) {
            const [table, column] = args
            const expectation = COLUMN_EXPECTATIONS.find(
              (item) => item.table === table && item.column === column,
            )
            const override = columnOverrides[`${table}.${column}`]
            if (override === null) return undefined
            return {
              data_type: expectation?.type,
              is_nullable: expectation?.nullable === false ? 'NO' : 'YES',
              column_default: expectation?.defaultValue ?? null,
              ...override,
            }
          }
          if (
            normalized.includes('information_schema.referential_constraints')
            && normalized.includes("tc.table_name = 'auth_refresh_token_history'")
          ) {
            return {
              column_name: 'session_id',
              foreign_table_name: 'user_sessions',
              foreign_column_name: 'id',
              delete_rule: 'CASCADE',
            }
          }
          if (normalized.includes('from pg_indexes')) {
            const indexName = args.at(-1)
            if (missingIndexes.includes(indexName)) return undefined
            if (indexName === 'ux_hamilton_manual_receipt_active_task') {
              return {
                indexdef: `CREATE UNIQUE INDEX ${indexName} ON public.hamilton_manual_submission_receipts USING btree (task_id) WHERE (status = 'active'::text)`,
                ready: true,
                valid: true,
              }
            }
            const [table] = args
            const column = indexName.endsWith('_session') ? 'session_id' : 'expires_at'
            return {
              indexdef: `CREATE INDEX ${indexName} ON public.${table} USING btree ("${column}")`,
            }
          }
          if (
            normalized.includes('from pg_constraint')
            && normalized.includes("t.relname = 'application_tasks'")
          ) {
            const literals = statuses.map((status) => `'${status}'::text`).join(', ')
            return {
              definition: `CHECK ((status = ANY (ARRAY[${literals}])))`,
              validated: true,
            }
          }
          if (normalized.includes('from pg_trigger')) {
            const [, triggerName] = args
            if (triggerOverrides[triggerName] === null) return undefined
            return {
              ...RECEIPT_TRIGGERS[triggerName],
              ...triggerOverrides[triggerName],
            }
          }
          throw new Error(`unexpected get query in test: ${normalized}`)
        },
        async all() {
          if (
            normalized.includes("constraint_type = 'primary key'")
            && normalized.includes("tc.table_name = 'auth_refresh_token_history'")
          ) {
            return [{ column_name: 'token_hash' }]
          }
          if (
            normalized.includes('json_agg(kcu.column_name')
            && normalized.includes("tc.table_name = 'hamilton_manual_submission_receipts'")
          ) return receiptKeys
          if (
            normalized.includes('information_schema.referential_constraints')
            && normalized.includes("tc.table_name = 'hamilton_manual_submission_receipts'")
          ) return receiptForeignKeys
          if (
            normalized.includes('from pg_constraint')
            && normalized.includes("t.relname = 'hamilton_manual_submission_receipts'")
          ) return receiptChecks
          throw new Error(`unexpected all query in test: ${normalized}`)
        },
      }
    },
  }
}

test('PostgreSQL migration 0168 adds every missing migration-036 parity field additively', async () => {
  const sql = await readFile(MIGRATION_PATH, 'utf8')
  for (const [table, column, declaration] of MIGRATION_036_PARITY_COLUMNS) {
    const pattern = new RegExp(
      `ALTER\\s+TABLE\\s+${escapeRegex(table)}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${escapeRegex(column)}\\s+${escapeRegex(declaration)}\\s*;`,
      'i',
    )
    assert.match(sql, pattern, `missing additive declaration for ${table}.${column}`)
  }
})

test('PostgreSQL verifier requires every new migration-036 parity field', () => {
  const verified = new Set(COLUMN_EXPECTATIONS.map(({ table, column }) => `${table}.${column}`))
  for (const [table, column] of MIGRATION_036_PARITY_COLUMNS) {
    assert.ok(verified.has(`${table}.${column}`), `${table}.${column} is not release-verified`)
  }
})

test('PostgreSQL migration 0170 installs additive receipt storage and append-only guards', async () => {
  const sql = await readFile(RECEIPT_MIGRATION_PATH, 'utf8')

  assert.match(
    sql,
    /ALTER\s+TABLE\s+application_tasks\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+output_proposal_document_id\s+TEXT/i,
    'receipt migration must create every application-task field named by its trigger',
  )
  assert.match(
    sql,
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+hamilton_manual_submission_receipts\s*\(/i,
  )
  assert.doesNotMatch(sql, /\b(?:DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i)
  for (const [column, table] of [
    ['task_id', 'application_tasks'],
    ['profile_id', 'profiles'],
    ['document_id', 'documents'],
  ]) {
    assert.match(
      sql,
      new RegExp(
        `${column}\\s+TEXT\\s+NOT\\s+NULL(?:\\s+UNIQUE)?\\s+REFERENCES\\s+${table}\\(id\\)\\s+ON\\s+DELETE\\s+RESTRICT`,
        'i',
      ),
      `${column} must be a RESTRICT foreign key to ${table}.id`,
    )
  }
  assert.match(sql, /document_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  assert.match(sql, /UNIQUE\s*\(\s*task_id\s*,\s*idempotency_key\s*\)/i)
  assert.match(sql, /portal_target_sha256\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*portal_target_sha256\s*\)\s*=\s*64\s*\)/i)
  assert.match(sql, /task_identity_sha256\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*task_identity_sha256\s*\)\s*=\s*64\s*\)/i)
  assert.match(sql, /CHECK\s*\(\s*channel\s*=\s*'portal_manual'\s*\)/i)
  assert.match(
    sql,
    /CHECK\s*\(\s*mime_type\s+IN\s*\(\s*'application\/pdf'\s*,\s*'image\/png'\s*,\s*'image\/jpeg'\s*\)\s*\)/i,
  )
  assert.match(
    sql,
    /CHECK\s*\(\s*status\s+IN\s*\(\s*'active'\s*,\s*'revoked'\s*\)\s*\)/i,
  )
  assert.match(
    sql,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ux_hamilton_manual_receipt_active_task[\s\S]*?\(\s*task_id\s*\)[\s\S]*?WHERE\s+status\s*=\s*'active'/i,
  )

  assert.match(
    sql,
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_hamilton_manual_receipt_document\s*\(/i,
  )
  assert.match(
    sql,
    /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_hamilton_manual_receipt_document_immutable\s+ON\s+documents/i,
  )
  assert.match(
    sql,
    /CREATE\s+TRIGGER\s+trg_hamilton_manual_receipt_document_immutable\s+BEFORE\s+UPDATE\s+OF\s+file_bytes\s*,\s*content_hash\s+ON\s+documents/i,
  )
  assert.match(sql, /NEW\.file_bytes\s+IS\s+DISTINCT\s+FROM\s+OLD\.file_bytes/i)
  assert.match(sql, /NEW\.content_hash\s+IS\s+DISTINCT\s+FROM\s+OLD\.content_hash/i)

  assert.match(
    sql,
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_hamilton_manual_receipt_binding\s*\(/i,
  )
  assert.match(
    sql,
    /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_hamilton_manual_receipt_binding_append_only[\s\S]*?ON\s+hamilton_manual_submission_receipts/i,
  )
  assert.match(
    sql,
    /CREATE\s+TRIGGER\s+trg_hamilton_manual_receipt_binding_append_only\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+hamilton_manual_submission_receipts/i,
  )
  assert.match(sql, /IF\s+TG_OP\s*=\s*'DELETE'/i)
  assert.match(sql, /OLD\.status\s*=\s*'revoked'/i)
  assert.match(sql, /NEW\.status\s*<>\s*'revoked'/i)
  assert.match(
    sql,
    /CREATE\s+TRIGGER\s+trg_hamilton_manual_receipt_task_identity[\s\S]*?BEFORE\s+UPDATE\s+OF[\s\S]*?ON\s+application_tasks/i,
  )
  assert.match(sql, /BEFORE\s+UPDATE\s+OF[\s\S]*?portal_url[\s\S]*?ON\s+application_tasks/i)
  assert.match(sql, /BEFORE\s+UPDATE\s+OF[\s\S]*?application_url[\s\S]*?ON\s+application_tasks/i)
  assert.match(sql, /BEFORE\s+UPDATE\s+OF[\s\S]*?submitted_at[\s\S]*?ON\s+application_tasks/i)
  assert.match(sql, /NEW\.profile_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.profile_id/i)
  assert.match(sql, /NEW\.opportunity_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.opportunity_id/i)
  assert.match(sql, /NEW\.output_document_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.output_document_id/i)
})

test('PostgreSQL verifier covers every release-critical manual receipt contract', () => {
  assert.ok(REQUIRED_TABLES.includes('hamilton_manual_submission_receipts'))

  const verified = new Map(
    COLUMN_EXPECTATIONS.map((expectation) => (
      [`${expectation.table}.${expectation.column}`, expectation]
    )),
  )
  assert.equal(verified.get('documents.file_bytes')?.type, 'bytea')
  for (const column of [
    'task_id',
    'profile_id',
    'document_id',
    'portal_origin',
    'portal_target_sha256',
    'task_identity_sha256',
    'submitted_at',
    'attested_at',
    'receipt_sha256',
    'request_fingerprint',
    'file_size',
    'mime_type',
    'status',
    'revoked_at',
    'revoked_by_user_id',
    'revocation_reason',
  ]) {
    assert.ok(
      verified.has(`hamilton_manual_submission_receipts.${column}`),
      `${column} is not release-verified`,
    )
  }
  assert.equal(
    verified.get('hamilton_manual_submission_receipts.submitted_at')?.type,
    'timestamp with time zone',
  )
  assert.equal(
    verified.get('hamilton_manual_submission_receipts.attested_at')?.type,
    'timestamp with time zone',
  )

  assert.equal(RECEIPT_KEY_EXPECTATIONS.length, 3)
  assert.equal(RECEIPT_FOREIGN_KEY_EXPECTATIONS.length, 3)
  assert.equal(RECEIPT_ENUM_EXPECTATIONS.length, 3)
  assert.equal(RECEIPT_TRIGGER_EXPECTATIONS.length, 3)
})

test('PostgreSQL verifier accepts the canonical schema snapshot', async () => {
  const result = await verifyPgSchema(makeSchemaDb())
  assert.deepEqual(result, { failures: [], wrongDialect: false })
})

test('PostgreSQL verifier catalog queries are read-only', async () => {
  const capturedSql = []
  const result = await verifyPgSchema(makeSchemaDb({ capturedSql }))
  assert.deepEqual(result.failures, [])
  assert.ok(capturedSql.length > 0)
  for (const sql of capturedSql) {
    assert.match(sql.trim(), /^SELECT\b/i)
    assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|drop|create|truncate)\b/i)
  }
})

test('PostgreSQL verifier fails closed on missing receipt table, key, FK, index, and trigger', async () => {
  const result = await verifyPgSchema(makeSchemaDb({
    missingTables: ['hamilton_manual_submission_receipts'],
    missingIndexes: ['ux_hamilton_manual_receipt_active_task'],
    receiptForeignKeys: RECEIPT_FOREIGN_KEYS.filter((row) => row.column_name !== 'document_id'),
    receiptKeys: RECEIPT_KEYS.filter((row) => row.columns_json !== '["document_id"]'),
    triggerOverrides: {
      trg_hamilton_manual_receipt_binding_append_only: null,
      trg_hamilton_manual_receipt_task_identity: null,
    },
  }))

  assert.ok(result.failures.includes('missing table: hamilton_manual_submission_receipts'))
  assert.ok(result.failures.includes(
    'missing unique: hamilton_manual_submission_receipts(document_id)',
  ))
  assert.ok(result.failures.includes(
    'missing foreign key: hamilton_manual_submission_receipts.document_id',
  ))
  assert.ok(result.failures.includes(
    'missing index: ux_hamilton_manual_receipt_active_task',
  ))
  assert.ok(result.failures.includes(
    'missing trigger: trg_hamilton_manual_receipt_binding_append_only on hamilton_manual_submission_receipts',
  ))
  assert.ok(result.failures.includes(
    'missing trigger: trg_hamilton_manual_receipt_task_identity on application_tasks',
  ))
})

test('PostgreSQL verifier rejects receipt byte, enum, FK-delete, index, and trigger drift', async () => {
  const driftedChecks = RECEIPT_CHECKS.map((row) => (
    row.definition.includes('mime_type')
      ? { definition: "CHECK ((mime_type = 'application/pdf'::text))", validated: true }
      : row
  ))
  const result = await verifyPgSchema(makeSchemaDb({
    columnOverrides: {
      'documents.file_bytes': { data_type: 'text' },
      'hamilton_manual_submission_receipts.submitted_at': {
        data_type: 'timestamp without time zone',
      },
    },
    receiptChecks: driftedChecks,
    receiptForeignKeys: RECEIPT_FOREIGN_KEYS.map((row) => (
      row.column_name === 'task_id' ? { ...row, delete_rule: 'CASCADE' } : row
    )),
    triggerOverrides: {
      trg_hamilton_manual_receipt_document_immutable: { enabled: 'D' },
    },
  }))

  assert.ok(result.failures.some((failure) => failure.includes('documents.file_bytes is text')))
  assert.ok(result.failures.some((failure) => failure.includes(
    'submitted_at is timestamp without time zone',
  )))
  assert.ok(result.failures.some((failure) => failure.includes(
    'task_id must reference application_tasks.id ON DELETE RESTRICT',
  )))
  assert.ok(result.failures.some((failure) => failure.includes('mime_type check drift')))
  assert.ok(result.failures.some((failure) => failure.includes(
    'document_immutable is not enabled for ordinary writes',
  )))
})

test('PostgreSQL verifier rejects timestamp and Hamilton constraint drift', async () => {
  const result = await verifyPgSchema(makeSchemaDb({
    columnOverrides: {
      'auth_refresh_token_history.expires_at': { data_type: 'timestamp without time zone' },
    },
    statuses: APPLICATION_TASK_STATUSES.filter((status) => status !== 'submit_evidence_pending'),
  }))
  assert.ok(result.failures.some((failure) => failure.includes('expires_at is timestamp without time zone')))
  assert.ok(result.failures.some((failure) => failure.includes('missing: submit_evidence_pending')))
})

test('constraint parser handles PostgreSQL ANY-array normalization exactly', () => {
  const definition = "CHECK ((status = ANY (ARRAY['queued'::text, 'submit_attempt_started'::text])))"
  assert.deepEqual(
    extractStatusConstraintValues(definition),
    ['queued', 'submit_attempt_started'],
  )
})

test('refresh-history index verifier rejects accidental compound indexes', () => {
  assert.equal(
    indexCoversOnlyColumn(
      'CREATE INDEX idx ON public.auth_refresh_token_history USING btree (session_id)',
      'session_id',
    ),
    true,
  )
  assert.equal(
    indexCoversOnlyColumn(
      'CREATE INDEX idx ON public.auth_refresh_token_history USING btree (session_id, expires_at)',
      'session_id',
    ),
    false,
  )
})

test('application-task status preflight is read-only and reports unknown persisted states', async () => {
  assert.doesNotMatch(
    APPLICATION_TASK_STATUS_COUNTS_SQL,
    /\b(?:insert|update|delete|alter|drop|create|truncate)\b/i,
  )
  const rows = [
    { status: 'queued', task_count: '12' },
    { status: 'legacy_unknown', task_count: '2' },
  ]
  const assessed = assessApplicationTaskStatusCounts(rows)
  assert.deepEqual(assessed.counts, [
    { status: 'queued', taskCount: '12' },
    { status: 'legacy_unknown', taskCount: '2' },
  ])
  assert.deepEqual(assessed.unexpected, [
    { status: 'legacy_unknown', taskCount: '2' },
  ])

  let capturedSql = ''
  const result = await preflightApplicationTaskStatuses({
    dialect: 'postgres',
    prepare(sql) {
      capturedSql = sql
      return { all: async () => rows }
    },
  })
  assert.equal(capturedSql, APPLICATION_TASK_STATUS_COUNTS_SQL)
  assert.equal(result.unexpected.length, 1)
  assert.equal(result.wrongDialect, false)
})
