/**
 * Test to prevent duplicate scoring logic files
 * This test ensures that PR #133's fix remains in place and 
 * prevents regression of duplicate AIGrantScorer files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

    possibleLocations.forEach(filePath => {
      if (fs.existsSync(filePath)) {
        scorerFiles.push(filePath);
      }
    });

    // Should only have ONE AIGrantScorer file (in pages directory)
    expect(scorerFiles).toHaveLength(1);
    
    // The single file should be in the pages directory (canonical location)
    if (scorerFiles.length === 1) {
      expect(scorerFiles[0]).toMatch(/pages[\\\/]AIGrantScorer\.jsx$/);
      console.log(`✓ Single AIGrantScorer found at: ${scorerFiles[0]}`);
    } else if (scorerFiles.length > 1) {
      console.error(`✗ Multiple AIGrantScorer files found:`);
      scorerFiles.forEach(file => console.error(`  - ${file}`));
    } else {
      console.error(`✗ No AIGrantScorer files found`);
    }
  });

  test('should have consistent imports for AIGrantScorer', () => {
    // Check that all imports point to the same canonical location
    const indexFiles = [
      path.join(srcDir, 'index.jsx'),
      path.join(srcDir, 'pages', 'index.jsx'),
    ];

    const imports = [];
    
    indexFiles.forEach(indexFile => {
      if (fs.existsSync(indexFile)) {
        const content = fs.readFileSync(indexFile, 'utf-8');
        const importMatch = content.match(/import\s+AIGrantScorer\s+from\s+['"](.+?)['"];/);
        
        if (importMatch) {
          imports.push({
            file: indexFile,
            importPath: importMatch[1],
            resolvedPath: path.resolve(path.dirname(indexFile), importMatch[1] + '.jsx')
          });
        }
      }
    });

    // All imports should resolve to the same file
    if (imports.length > 1) {
      const uniquePaths = new Set(imports.map(imp => imp.resolvedPath));
      expect(uniquePaths.size).toBe(1);
      
      if (uniquePaths.size > 1) {
        console.error('✗ Inconsistent AIGrantScorer imports:');
        imports.forEach(imp => {
          console.error(`  ${imp.file} imports from ${imp.importPath} (resolves to ${imp.resolvedPath})`);
        });
      }
    }
  });
});