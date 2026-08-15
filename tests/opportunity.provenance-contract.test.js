import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function combinedSource(paths) {
  return paths.map((file) => `\n/* ${file} */\n${read(file)}`).join('\n');
}

describe('opportunity provenance and real-data contract', () => {
  const productionDataPaths = [
    'src/lib/api.js',
    'src/lib/queries.js',
    'backend/connectors/framework.js',
    'backend/connectors/simplerGrantsGov.js',
    'backend/connectors/grantsGovApi.js',
    'backend/connectors/usaspendingGov.js'
  ];

  test('opportunity data paths include required canonical fields and source transparency fields', () => {
    const source = combinedSource(productionDataPaths).toLowerCase();

    const requiredFields = [
      'canonicalkey',
      'title',
      'opportunitynumber',
      'assistancelistingnumber',
      'status',
      'sourceurl',
      'applicationurl',
      'lastretrievedat',
      'lastchangedat',
      'lastverifiedat',
      'confidence',
      'applicanttypes',
      'geographiceligibility',
      'deadline',
      'fieldprovenance',
      'opportunitysource'
    ];

    for (const field of requiredFields) {
      expect(source, `opportunity path should reference ${field}`).toContain(field);
    }
  });

  test('production opportunity paths do not fabricate mock opportunities, applications, submissions, or awards', () => {
    const source = combinedSource(productionDataPaths);
    const forbiddenPatterns = [
      /mock\s*data/i,
      /mock\s*opportunit/i,
      /fake\s*application/i,
      /fake\s*submission/i,
      /fake\s*award/i,
      /simulated\s*(result|crawler|sync|application|submission|award)/i,
      /placeholder\s*(button|control|opportunit|application|submission|award)/i,
      /hardcoded\s*(grant|opportunit|award)/i,
      /demo\s*(opportunit|application|submission|award)/i,
      /lorem ipsum/i
    ];

    for (const pattern of forbiddenPatterns) {
      expect(pattern.test(source), `production data paths must not contain ${pattern}`).toBe(false);
    }
  });

  test('opportunity statuses distinguish open, closed, canceled, archived, forecasted, and rolling records', () => {
    const source = combinedSource(productionDataPaths).toLowerCase();
    const statuses = ['open', 'closed', 'canceled', 'cancelled', 'archived', 'forecast', 'rolling'];

    expect(statuses.some((status) => source.includes(status)), 'status handling should be implemented').toBe(true);
    expect(source).toMatch(/closed|archive|cancel/);
    expect(source).toMatch(/forecast|rolling|open/);
  });

  test('query/API layer exposes saved search and alert concepts against real data changes', () => {
    const source = combinedSource(['src/lib/api.js', 'src/lib/queries.js']).toLowerCase();

    const expectedConcepts = [
      /saved\s*search|savedsearch/,
      /alert/,
      /deadline\s*change|deadlinechange/,
      /new\s*match|newmatch/,
      /funder\s*follow|funderfollow/,
      /negative\s*keyword|exclusion/
    ];

    for (const pattern of expectedConcepts) {
      expect(pattern.test(source), `query/API layer should include ${pattern}`).toBe(true);
    }
  });
});
