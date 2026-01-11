/**
 * Test to prevent duplicate scoring logic files
 *
 * This test ensures that the scoring page implementation doesn't regress into
 * multiple copies of AIGrantScorer living in different locations.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '../..');
const srcDir = path.join(rootDir, 'src');

describe('Scoring Logic Duplication Prevention', () => {
  test('should not have duplicate AIGrantScorer files', () => {
    const scorerFiles = [];

    // Check for AIGrantScorer files in various locations
    const possibleLocations = [
      path.join(srcDir, 'AIGrantScorer.jsx'),
      path.join(srcDir, 'pages', 'AIGrantScorer.jsx'),
      path.join(srcDir, 'components', 'AIGrantScorer.jsx'),
      path.join(srcDir, 'components', 'scoring', 'AIGrantScorer.jsx'),
    ];

    for (const filePath of possibleLocations) {
      if (fs.existsSync(filePath)) {
        scorerFiles.push(filePath);
      }
    }

    // Should only have ONE AIGrantScorer file (in pages directory)
    assert.equal(
      scorerFiles.length,
      1,
      `Expected exactly 1 AIGrantScorer file, found ${scorerFiles.length}:\n- ${scorerFiles.join('\n- ')}`,
    );

    // The single file should be in the pages directory (canonical location)
    assert.match(scorerFiles[0], /pages[\\\/]AIGrantScorer\.jsx$/);
  });

  test('should have consistent imports for AIGrantScorer', () => {
    // Check that all imports point to the same canonical location
    const indexFiles = [
      path.join(srcDir, 'index.jsx'),
      path.join(srcDir, 'pages', 'index.jsx'),
    ];

    const imports = [];

    for (const indexFile of indexFiles) {
      if (!fs.existsSync(indexFile)) continue;

      const content = fs.readFileSync(indexFile, 'utf-8');
      const importMatch = content.match(
        /import\s+AIGrantScorer\s+from\s+['"](.+?)['"];?/,
      );

      if (!importMatch) continue;

      const importPath = importMatch[1];
      const resolvedPath = importPath.endsWith('.jsx')
        ? path.resolve(path.dirname(indexFile), importPath)
        : path.resolve(path.dirname(indexFile), `${importPath}.jsx`);

      imports.push({
        file: indexFile,
        importPath,
        resolvedPath,
      });
    }

    // If multiple files import AIGrantScorer, they must resolve to the same file.
    if (imports.length > 1) {
      const uniquePaths = new Set(imports.map((imp) => imp.resolvedPath));
      assert.equal(
        uniquePaths.size,
        1,
        `Inconsistent AIGrantScorer imports:\n${imports
          .map((imp) => `- ${imp.file} imports ${imp.importPath} -> ${imp.resolvedPath}`)
          .join('\n')}`,
      );
    }
  });
});
