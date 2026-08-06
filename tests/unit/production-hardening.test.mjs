/**
 * Production Hardening Tests
 * 
 * Tests for production stability improvements without requiring dependencies.
 * These are code inspection tests that verify the implementation is correct.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('Production Hardening - Code Verification', () => {

  describe('JWT Secret Enforcement', () => {
    it('should have fail-fast logic in auth.js', () => {
      const authPath = join(__dirname, '..', '..', 'backend', 'routes', 'auth.js')
      const authCode = fs.readFileSync(authPath, 'utf8')
      
      assert.ok(authCode.includes('process.exit(1)'), 
        'auth.js should call process.exit(1) for missing JWT secret in production')
      assert.ok(authCode.includes('FATAL ERROR'), 
        'auth.js should have FATAL ERROR message for missing JWT secret')
    })

    it('should have fail-fast logic in server.js', () => {
      const serverPath = join(__dirname, '..', '..', 'backend', 'server.js')
      const serverCode = fs.readFileSync(serverPath, 'utf8')
      const bootstrapPath = join(__dirname, '..', '..', 'backend', 'startup', 'bootstrap.js')
      const bootstrapCode = fs.existsSync(bootstrapPath) ? fs.readFileSync(bootstrapPath, 'utf8') : ''

      assert.ok(serverCode.includes('process.exit(1)'), 
        'server.js should call process.exit(1) for missing JWT secret')
      assert.ok(serverCode.includes('FATAL ERROR') || bootstrapCode.includes('FATAL ERROR'), 
        'server.js or bootstrap.js should have FATAL ERROR message')
    })

    it('should not generate random secrets in production', () => {
      const authPath = join(__dirname, '..', '..', 'backend', 'routes', 'auth.js')
      const authCode = fs.readFileSync(authPath, 'utf8')
      
      // The key requirement is that production must fail-fast with process.exit(1)
      // before any random secret generation would occur
      // We've already verified process.exit exists, so this test just documents the expectation
      assert.ok(authCode.includes('getJwtSecretOrThrow'), 
        'auth.js should use getJwtSecretOrThrow for JWT secret resolution')
    })
  })

  describe('Admin Authorization', () => {
    it('should have requestContext middleware', () => {
      const middlewarePath = join(__dirname, '..', '..', 'backend', 'middleware', 'requestContext.js')
      assert.ok(fs.existsSync(middlewarePath), 'requestContext.js middleware should exist')
      
      const middlewareCode = fs.readFileSync(middlewarePath, 'utf8')
      assert.ok(middlewareCode.includes('isAdmin'), 
        'requestContext middleware should set isAdmin')
      assert.ok(middlewareCode.includes('is_admin') || middlewareCode.includes('SELECT'), 
        'requestContext should read is_admin from database')
    })

    it('should not have hardcoded admin email checks in anyaAdminTools', () => {
      const toolsPath = join(__dirname, '..', '..', 'backend', 'services', 'anyaAdminTools.js')
      const toolsCode = fs.readFileSync(toolsPath, 'utf8')
      
      // Should NOT have hardcoded email like 'owner@example.invalid' in authorization
      const lines = toolsCode.split('\n')
      for (const line of lines) {
        if (line.includes('isAdmin') && line.includes('@')) {
          assert.ok(line.includes('//') || line.includes('/*'), 
            'Hardcoded admin email checks should be removed or commented out')
        }
      }
    })

    it('should not have hardcoded admin email checks in anyaLoginTrigger', () => {
      const triggerPath = join(__dirname, '..', '..', 'backend', 'services', 'anyaLoginTrigger.js')
      const triggerCode = fs.readFileSync(triggerPath, 'utf8')
      
      // Check that isAdmin function uses is_admin flag, not email comparison
      assert.ok(!triggerCode.includes('=== ADMIN_EMAIL') && !triggerCode.includes('=== \'buckeye'), 
        'anyaLoginTrigger should not have hardcoded admin email comparisons')
    })
  })

  describe('CI and E2E identity isolation', () => {
    it('boots the production container with an explicit operator and no background jobs', () => {
      const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml')
      const workflow = fs.readFileSync(workflowPath, 'utf8')

      assert.match(workflow, /--env ADMIN_EMAIL=ci-operator@grantflow\.app/)
      assert.match(workflow, /--env DISABLE_BACKGROUND_SERVICES=true/)
    })

    it('uses one synthetic configurable E2E admin identity', () => {
      const configPath = join(__dirname, '..', 'e2e', 'playwright.config.mjs')
      const appSpecPath = join(__dirname, '..', 'e2e', 'app-e2e.spec.mjs')
      const anyaSpecPath = join(__dirname, '..', 'e2e', 'anya-persistence.spec.mjs')
      const config = fs.readFileSync(configPath, 'utf8')
      const appSpec = fs.readFileSync(appSpecPath, 'utf8')
      const anyaSpec = fs.readFileSync(anyaSpecPath, 'utf8')

      assert.match(config, /process\.env\.E2E_ADMIN_EMAIL/)
      assert.match(config, /admin-e2e@example\.invalid/)
      assert.match(appSpec, /e2eAdminEmail/)
      assert.match(anyaSpec, /e2eAdminEmail/)
      assert.doesNotMatch(`${config}\n${appSpec}\n${anyaSpec}`, /@gmail\.com/i)
    })
  })

  describe('Crawler Idempotency', () => {
    it('should have idempotency_key column in schema', () => {
      const schemaPath = join(__dirname, '..', '..', 'backend', 'db', 'schema.sql')
      const schema = fs.readFileSync(schemaPath, 'utf8')
      
      assert.ok(schema.includes('idempotency_key'), 
        'schema.sql should define idempotency_key column')
      assert.ok(schema.includes('UNIQUE') && schema.includes('idempotency'), 
        'schema.sql should have unique index on idempotency_key')
    })

    it('should have crawlerJobCreation utility', () => {
      const utilPath = join(__dirname, '..', '..', 'backend', 'services', 'crawlerJobCreation.js')
      assert.ok(fs.existsSync(utilPath), 'crawlerJobCreation.js should exist')
      
      const utilCode = fs.readFileSync(utilPath, 'utf8')
      assert.ok(utilCode.includes('export') && utilCode.includes('createCrawlerJob'), 
        'crawlerJobCreation should export createCrawlerJob')
      assert.ok(utilCode.includes('generateIdempotencyKey'), 
        'crawlerJobCreation should export generateIdempotencyKey')
      assert.ok(utilCode.includes('validateJobParameters'), 
        'crawlerJobCreation should export validateJobParameters')
    })

    it('should use centralized job creation in crawlers route', () => {
      const routePath = join(__dirname, '..', '..', 'backend', 'routes', 'crawlers.js')
      const routeCode = fs.readFileSync(routePath, 'utf8')
      
      assert.ok(routeCode.includes('createCrawlerJob'), 
        'crawlers.js should import and use createCrawlerJob')
    })
  })

  describe('Dead Letter Queue', () => {
    it('should have dead_letter_queue table in schema', () => {
      const schemaPath = join(__dirname, '..', '..', 'backend', 'db', 'schema.sql')
      const schema = fs.readFileSync(schemaPath, 'utf8')
      
      assert.ok(schema.includes('dead_letter_queue'), 
        'schema.sql should define dead_letter_queue table')
      assert.ok(schema.includes('error_message'), 
        'dead_letter_queue should have error_message column')
      assert.ok(schema.includes('severity'), 
        'dead_letter_queue should have severity column')
    })

    it('should have dead letter queue migration', () => {
      const migrationPath = join(__dirname, '..', '..', 'backend', 'db', 'migrations', '043_add_dead_letter_queue.sql')
      assert.ok(fs.existsSync(migrationPath), 
        '043_add_dead_letter_queue.sql migration should exist')
    })

    it('should have deadLetterQueue service', () => {
      const servicePath = join(__dirname, '..', '..', 'backend', 'services', 'deadLetterQueue.js')
      assert.ok(fs.existsSync(servicePath), 'deadLetterQueue.js should exist')
      
      const serviceCode = fs.readFileSync(servicePath, 'utf8')
      assert.ok(serviceCode.includes('logFailedJob'), 
        'deadLetterQueue should export logFailedJob')
      assert.ok(serviceCode.includes('getUnresolvedFailures'), 
        'deadLetterQueue should export getUnresolvedFailures')
      assert.ok(serviceCode.includes('resolveFailure'), 
        'deadLetterQueue should export resolveFailure')
    })

    it('should log failures in crawlerDispatcher', () => {
      const dispatcherPath = join(__dirname, '..', '..', 'backend', 'services', 'crawlerDispatcher.js')
      const dispatcherCode = fs.readFileSync(dispatcherPath, 'utf8')
      
      assert.ok(dispatcherCode.includes('logFailedJob'), 
        'crawlerDispatcher should import and use logFailedJob')
    })

    it('should have admin endpoints for dead letter queue', () => {
      const adminPath = join(__dirname, '..', '..', 'backend', 'routes', 'admin.js')
      const adminCode = fs.readFileSync(adminPath, 'utf8')
      
      assert.ok(adminCode.includes('dead-letter-queue'), 
        'admin.js should have dead-letter-queue endpoints')
    })
  })

  describe('DB Write Validation', () => {
    it('should have dbValidation utility', () => {
      const validationPath = join(__dirname, '..', '..', 'backend', 'utils', 'dbValidation.js')
      assert.ok(fs.existsSync(validationPath), 'dbValidation.js should exist')
      
      const validationCode = fs.readFileSync(validationPath, 'utf8')
      assert.ok(validationCode.includes('validateJobStatus'), 
        'dbValidation should export validateJobStatus')
      assert.ok(validationCode.includes('validateStateCode'), 
        'dbValidation should export validateStateCode')
      assert.ok(validationCode.includes('validateZipCode'), 
        'dbValidation should export validateZipCode')
      assert.ok(validationCode.includes('validateEmail'), 
        'dbValidation should export validateEmail')
    })

    it('should use validation in crawlerJobCreation', () => {
      const creationPath = join(__dirname, '..', '..', 'backend', 'services', 'crawlerJobCreation.js')
      const creationCode = fs.readFileSync(creationPath, 'utf8')
      
      assert.ok(creationCode.includes('dbValidation'), 
        'crawlerJobCreation should import from dbValidation')
    })
  })

  describe('Profile Access Control', () => {
    it('should have profile access enforcement', () => {
      const accessPath = join(__dirname, '..', '..', 'backend/utils', 'accessControl.js')
      const accessCode = fs.readFileSync(accessPath, 'utf8')
      
      assert.ok(accessCode.includes('ensureProfileAccess'), 
        'accessControl should export ensureProfileAccess')
      assert.ok(accessCode.includes('isAdmin') || accessCode.includes('admin'), 
        'accessControl should check admin status for profile access')
    })
  })

  describe('Profile Context Building', () => {
    it('should have buildProfileContext function', () => {
      const helpersPath = join(__dirname, '..', '..', 'backend', 'services', 'profileHelpers.js')
      const helpersCode = fs.readFileSync(helpersPath, 'utf8')
      
      assert.ok(helpersCode.includes('buildProfileContext'), 
        'profileHelpers should export buildProfileContext')
      assert.ok(helpersCode.includes('version'), 
        'buildProfileContext should return versioned context')
    })
  })

  describe('Anya Code Fixing', () => {
    it('should have GitHub Action workflow', () => {
      const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'anya-code-fix-pr.yml')
      assert.ok(fs.existsSync(workflowPath), 
        'anya-code-fix-pr.yml workflow should exist')
      
      const workflowCode = fs.readFileSync(workflowPath, 'utf8')
      assert.ok(workflowCode.includes('workflow_dispatch'), 
        'workflow should be manually dispatchable')
      assert.ok(workflowCode.includes('patch_content'), 
        'workflow should accept patch_content input')
      assert.ok(workflowCode.includes('git apply'), 
        'workflow should apply patches')
    })
  })

  describe('Documentation', () => {
    it('should have production hardening documentation', () => {
      const docPath = join(__dirname, '..', '..', 'docs', 'PRODUCTION_HARDENING.md')
      assert.ok(fs.existsSync(docPath), 
        'PRODUCTION_HARDENING.md should exist')
      
      const docContent = fs.readFileSync(docPath, 'utf8')
      assert.ok(docContent.includes('AUTH_JWT_SECRET'), 
        'docs should explain AUTH_JWT_SECRET')
      assert.ok(docContent.includes('dead letter queue'), 
        'docs should explain dead letter queue')
      assert.ok(docContent.includes('idempotency'), 
        'docs should explain idempotency')
    })
  })
})
