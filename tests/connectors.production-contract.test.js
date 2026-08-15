import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const connectorDir = path.join(root, 'backend', 'connectors');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function normalizeSource(source) {
  return source.replace(/\s+/g, ' ').toLowerCase();
}

describe('production connector contract', () => {
  test('all connector modules are importable and expose a usable API surface', async () => {
    const files = [
      'backend/connectors/framework.js',
      'backend/connectors/simplerGrantsGov.js',
      'backend/connectors/grantsGovApi.js',
      'backend/connectors/usaspendingGov.js'
    ];

    for (const file of files) {
      const imported = await import(path.join(root, file));
      const exportedKeys = Object.keys(imported).filter((key) => key !== '__esModule');
      expect(exportedKeys.length, `${file} should export connector functions/classes`).toBeGreaterThan(0);

      const exportedValues = exportedKeys.map((key) => imported[key]);
      expect(
        exportedValues.some((value) => ['function', 'object'].includes(typeof value) && value !== null),
        `${file} should expose at least one function or connector object`
      ).toBe(true);
    }
  });

  test('connector framework includes reliability primitives required for real syncs', () => {
    const source = normalizeSource(read('backend/connectors/framework.js'));

    const requiredConcepts = [
      ['checkpointing', /checkpoint/],
      ['retry or exponential backoff', /retry|backoff|exponential/],
      ['rate limiting', /rate\s*limit|ratelimit|throttle/],
      ['content hashing', /content\s*hash|contenthash|sha256|hash/],
      ['raw record retention', /raw\s*record|rawsourcerecord|raw\s*payload|rawstorage/],
      ['source health tracking', /health|last\s*successful\s*sync|lastsuccessfulsync/],
      ['structured errors', /structurederr|error\s*summary|error\s*code|connectorerror/],
      ['idempotent upserts', /idempotent|upsert|canonical\s*key|dedup/],
      ['cancellation/amendment/archive detection', /cancel|cancell|amend|archive|closed/]
    ];

    for (const [label, pattern] of requiredConcepts) {
      expect(pattern.test(source), `framework should include ${label}`).toBe(true);
    }
  });

  test('source-specific connectors target official public APIs and not competitor or fixture data', () => {
    const connectorExpectations = [
      {
        file: 'backend/connectors/grantsGovApi.js',
        officialDomain: /grants\.gov|api\.grants\.gov/i
      },
      {
        file: 'backend/connectors/simplerGrantsGov.js',
        officialDomain: /simpler\.grants\.gov|grants\.gov/i
      },
      {
        file: 'backend/connectors/usaspendingGov.js',
        officialDomain: /api\.usaspending\.gov|usaspending\.gov/i
      }
    ];

    const forbiddenProductionPatterns = [
      /mock\s*opportunit/i,
      /fake\s*opportunit/i,
      /sample\s*grant/i,
      /simulated\s*(crawler|sync|record|opportunit|result)/i,
      /demo\s*(grant|opportunit|award)/i,
      /placeholder\s*(grant|opportunit|award|application)/i,
      /math\.random\s*\(/i,
      /lorem ipsum/i,
      /competitor/i,
      /bypass\s*(captcha|auth|authentication|robots)/i
    ];

    for (const { file, officialDomain } of connectorExpectations) {
      const source = read(file);
      expect(officialDomain.test(source), `${file} should reference its official authorized source`).toBe(true);

      for (const pattern of forbiddenProductionPatterns) {
        expect(pattern.test(source), `${file} must not contain ${pattern}`).toBe(false);
      }
    }
  });

  test('connector files are present in the expected backend connector directory', () => {
    const connectorFiles = fs.readdirSync(connectorDir).filter((file) => file.endsWith('.js'));
    expect(connectorFiles).toEqual(
      expect.arrayContaining([
        'framework.js',
        'simplerGrantsGov.js',
        'grantsGovApi.js',
        'usaspendingGov.js'
      ])
    );
  });
});
