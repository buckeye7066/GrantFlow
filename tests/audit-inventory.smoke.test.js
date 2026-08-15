import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const auditPath = path.join(process.cwd(), 'docs', 'AUDIT_INVENTORY.md');

describe('audit inventory smoke checks', () => {
  test('audit inventory exists and references the exact app name grant-flow', () => {
    expect(fs.existsSync(auditPath)).toBe(true);
    const audit = fs.readFileSync(auditPath, 'utf8');
    expect(audit).toMatch(/grant-flow/i);
  });

  test('audit inventory classifies features using explicit production-readiness states', () => {
    const audit = fs.readFileSync(auditPath, 'utf8').toLowerCase();
    const requiredStates = ['working', 'partial', 'broken', 'simulated', 'disconnected', 'obsolete'];

    for (const state of requiredStates) {
      expect(audit, `AUDIT_INVENTORY.md should classify ${state} functionality`).toContain(state);
    }
  });

  test('audit inventory does not claim simulated crawler or fake application flows are production-ready', () => {
    const audit = fs.readFileSync(auditPath, 'utf8');

    const overclaimPatterns = [
      /simulated\s+crawler[^\n]*(production-ready|complete|fully working)/i,
      /fake\s+application[^\n]*(production-ready|complete|fully working)/i,
      /mock\s+opportunit[^\n]*(production-ready|complete|fully working)/i,
      /placeholder\s+control[^\n]*(production-ready|complete|fully working)/i
    ];

    for (const pattern of overclaimPatterns) {
      expect(pattern.test(audit), `audit inventory must not overclaim ${pattern}`).toBe(false);
    }
  });
});
