import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('application lifecycle submission guard', () => {
  test('API/query lifecycle code requires real submission confirmation evidence', () => {
    const source = [
      read('src/lib/api.js'),
      read('src/lib/queries.js')
    ].join('\n').toLowerCase();

    expect(source).toMatch(/submitted|submission/);

    const confirmationEvidencePatterns = [
      /confirmation\s*number|confirmationnumber/,
      /confirmation\s*document|confirmationdocumentid/,
      /official\s*receipt|officialreceipturl|receipt/,
      /manual\s*confirmation|explicit\s*manual\s*confirmation/
    ];

    expect(
      confirmationEvidencePatterns.some((pattern) => pattern.test(source)),
      'submitted transition must require confirmation number, receipt/proof URL, uploaded document, or explicit manual confirmation'
    ).toBe(true);
  });

  test('production lifecycle paths do not contain fake submission or award success messages', () => {
    const source = [
      read('src/lib/api.js'),
      read('src/lib/queries.js')
    ].join('\n');

    const forbiddenPatterns = [
      /fake\s*submission/i,
      /fake\s*award/i,
      /simulated\s*submission/i,
      /simulated\s*award/i,
      /application\s*submitted\s*successfully/i,
      /award\s*created\s*successfully/i,
      /todo:\s*submission/i,
      /todo:\s*award/i
    ];

    for (const pattern of forbiddenPatterns) {
      expect(pattern.test(source), `lifecycle path must not contain ${pattern}`).toBe(false);
    }
  });

  test('lifecycle stages include pre-submission, submitted, outcome, reporting, and closeout states', () => {
    const source = [
      read('src/lib/api.js'),
      read('src/lib/queries.js')
    ].join('\n').toLowerCase();

    const requiredStages = [
      'prospect',
      'researching',
      'qualified',
      'preparing',
      'drafting',
      'internal review',
      'ready to submit',
      'submitted',
      'awarded',
      'declined',
      'reporting',
      'closeout'
    ];

    for (const stage of requiredStages) {
      const compact = stage.replace(/\s+/g, '');
      expect(
        source.includes(stage) || source.includes(compact),
        `lifecycle should include stage: ${stage}`
      ).toBe(true);
    }
  });
});
