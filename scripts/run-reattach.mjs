#!/usr/bin/env node
/**
 * Run reattach script with explicit output
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = join(__dirname, 'reattach-users-simple.mjs');

console.log('Starting reattach script...\n');

const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false
});

child.on('close', (code) => {
  console.log(`\nScript exited with code ${code}`);
  process.exit(code || 0);
});

child.on('error', (error) => {
  console.error('Failed to start script:', error);
  process.exit(1);
});
