import { test } from 'node:test'
import assert from 'node:assert/strict'

// Test the placeholder conversion logic
// This validates the core logic used in backend/db/index.js

function qmarkToDollarPlaceholders(sql) {
  let out = ''
  let idx = 0
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    if (ch === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") {
        out += "''"
        i++
        continue
      }
      inSingle = !inSingle
      out += ch
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      out += ch
      continue
    }

    if (ch === '?' && !inSingle && !inDouble) {
      idx += 1
      out += `$${idx}`
      continue
    }

    out += ch
  }

  return { text: out, count: idx }
}

test('Placeholder conversion: simple INSERT with 3 parameters', () => {
  const sql = 'INSERT INTO test (a, b, c) VALUES (?, ?, ?)'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'INSERT INTO test (a, b, c) VALUES ($1, $2, $3)')
  assert.equal(result.count, 3)
})

test('Placeholder conversion: INSERT with NULL parameters', () => {
  const sql = 'INSERT INTO test (id, name, data) VALUES (?, ?, ?)'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'INSERT INTO test (id, name, data) VALUES ($1, $2, $3)')
  assert.equal(result.count, 3)
  
  // Verify that NULL can be passed as a parameter
  // In actual usage: .run(id, null, data) would be valid
})

test('Placeholder conversion: UPDATE with WHERE clause', () => {
  const sql = 'UPDATE test SET name = ?, data = ? WHERE id = ?'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'UPDATE test SET name = $1, data = $2 WHERE id = $3')
  assert.equal(result.count, 3)
})

test('Placeholder conversion: SELECT with multiple WHERE conditions', () => {
  const sql = 'SELECT * FROM test WHERE id = ? AND status = ? AND type = ?'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'SELECT * FROM test WHERE id = $1 AND status = $2 AND type = $3')
  assert.equal(result.count, 3)
})

test('Placeholder conversion: ignore ? inside single quotes', () => {
  const sql = "INSERT INTO test (question) VALUES ('What is your name?')"
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, "INSERT INTO test (question) VALUES ('What is your name?')")
  assert.equal(result.count, 0)
})

test('Placeholder conversion: ignore ? inside double quotes', () => {
  const sql = 'INSERT INTO test ("col?name") VALUES (?)'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'INSERT INTO test ("col?name") VALUES ($1)')
  assert.equal(result.count, 1)
})

test('Placeholder conversion: handle escaped quotes', () => {
  const sql = "INSERT INTO test (text) VALUES ('It''s a test?'), (?)"
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, "INSERT INTO test (text) VALUES ('It''s a test?'), ($1)")
  assert.equal(result.count, 1)
})

test('Placeholder conversion: complex query with JSON', () => {
  const sql = `
    INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.ok(result.text.includes('$1'))
  assert.ok(result.text.includes('$7'))
  assert.equal(result.count, 7)
})

test('Placeholder conversion: validates crawler_jobs INSERT query', () => {
  // This is the exact query from admin.js after the fix
  const sql = `
    INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
    VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
  `
  const result = qmarkToDollarPlaceholders(sql)
  
  // Should convert the 5 ? placeholders to $1, $2, $3, $4, $5
  assert.equal(result.count, 5)
  assert.ok(result.text.includes('$1'))
  assert.ok(result.text.includes('$5'))
  
  // Verify the literals are preserved
  assert.ok(result.text.includes("'document_ingest'"))
  assert.ok(result.text.includes("'queued'"))
})

test('Placeholder conversion: validates documents INSERT query', () => {
  // This is the query from documents.js
  const sql = `
    INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
    VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
  `
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.count, 5)
  // Ensures parameter count matches: jobId, profileId, organization_id, JSON.stringify(...), requestedBy
})

test('Parameter count validation: detect mismatch', () => {
  const sql = 'INSERT INTO test (a, b, c, d) VALUES (?, ?, ?, ?)'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.count, 4)
  
  // In real usage, if we only pass 3 parameters to .run(), Postgres will fail with:
  // "bind message supplies 3 parameters, but prepared statement requires 4"
  // This is the user-facing error that helps debug parameter count mismatches
})

test('Type inference: NULL parameter handling', () => {
  // Postgres can infer types for most queries, but ambiguous NULLs may fail
  // Example: INSERT INTO test (json_col) VALUES (?)
  // If we pass NULL without cast, Postgres can't infer type
  
  // Solution: Always use explicit type casts or JSON.stringify for JSON columns
  const sql = 'INSERT INTO test (data) VALUES (?::jsonb)'
  const result = qmarkToDollarPlaceholders(sql)
  
  assert.equal(result.text, 'INSERT INTO test (data) VALUES ($1::jsonb)')
  assert.equal(result.count, 1)
  
  // Note: The ::jsonb cast helps Postgres infer the type even if NULL is passed
})

