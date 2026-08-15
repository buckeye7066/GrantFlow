import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let axeSource = null;

async function getAxeSource() {
  if (axeSource) return axeSource;
  const candidate = resolve(process.cwd(), 'node_modules', 'axe-core', 'axe.js');
  try {
    axeSource = await readFile(candidate, 'utf8');
    return axeSource;
  } catch {
    return null;
  }
}

export const WCAG_2_2_AA_RULESET = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  },
};

export async function assertNoViolations(page, options = {}) {
  const source = await getAxeSource();
  if (!source) {
    return { skipped: true, reason: 'axe-core not installed' };
  }
  await page.evaluate((src) => { window.eval(src); }, source);
  const result = await page.evaluate((opts) => window.axe.run(document, opts), {
    ...WCAG_2_2_AA_RULESET,
    ...options,
  });
  const summary = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    count: v.nodes.length,
  }));
  if (result.violations.length > 0) {
    const message = `Accessibility violations:\n${JSON.stringify(summary, null, 2)}`;
    throw new Error(message);
  }
  return { skipped: false, violations: [] };
}

export function baseUrl() {
  // Match tests/smoke/playwright.config.mjs, which self-starts the Express
  // server on 8080 — defaulting to the Vite dev port here would point every
  // spec at a server nothing started.
  return process.env.SMOKE_BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:8080';
}
