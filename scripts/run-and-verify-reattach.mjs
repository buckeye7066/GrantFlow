#!/usr/bin/env node
/**
 * Run reattach and verify in one script
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const output = [];
const errors = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${String(msg)}`;
  console.log(line);
  output.push(line);
}

function error(msg) {
  const line = `[ERROR] ${String(msg)}`;
  console.error(line);
  errors.push(line);
}

log('=== STARTING REATTACH AND VERIFY ===\n');

// Step 1: Run reattach
log('Step 1: Running reattach script...');
const reattachScript = join(__dirname, 'reattach-users-simple.mjs');

await new Promise((resolve) => {
  const child = spawn(process.execPath, [reattachScript, ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  });
  
  let stdout = '';
  let stderr = '';
  
  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    log(text.trim());
  });
  
  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    error(text.trim());
  });
  
  child.on('close', (code) => {
    log(`\nReattach script exited with code ${code}`);
    if (code !== 0) {
      error(`Reattach script failed with exit code ${code}`);
      error(`STDERR: ${stderr}`);
    }
    resolve();
  });
  
  child.on('error', (err) => {
    error(`Failed to start reattach script: ${err.message}`);
    resolve();
  });
});

// Step 2: Check for summary file
log('\nStep 2: Checking for summary file...');
const summaryPath = join(__dirname, '..', 'reattach-summary.json');
try {
  const fs = await import('fs');
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    log('Summary found:');
    log(`  Admin: ${summary.admin?.display_name} (${summary.admin?.id})`);
    log(`  Linked profiles: ${summary.linked?.length || 0}`);
    log(`  Admin linked: ${summary.adminLinked || 0}`);
    log(`  Total profiles: ${summary.stats?.total || 0}`);
    log(`  Linked profiles: ${summary.stats?.linked || 0}`);
  } else {
    log('Summary file not found');
  }
} catch (err) {
  error(`Error reading summary: ${err.message}`);
}

// Step 3: Run verification
log('\nStep 3: Running verification script...');
const verifyScript = join(__dirname, 'verify-reattach.mjs');

await new Promise((resolve) => {
  const child = spawn(process.execPath, [verifyScript], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  });
  
  let stdout = '';
  let stderr = '';
  
  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    log(text.trim());
  });
  
  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    error(text.trim());
  });
  
  child.on('close', (code) => {
    log(`\nVerification script exited with code ${code}`);
    if (code !== 0) {
      error(`Verification script failed with exit code ${code}`);
      error(`STDERR: ${stderr}`);
    }
    resolve();
  });
  
  child.on('error', (err) => {
    error(`Failed to start verification script: ${err.message}`);
    resolve();
  });
});

// Step 4: Write combined output
log('\n=== COMPLETE ===');
const outputPath = join(__dirname, '..', 'reattach-verify-complete.txt');
writeFileSync(outputPath, output.join('\n'));
if (errors.length > 0) {
  writeFileSync(join(__dirname, '..', 'reattach-verify-errors.txt'), errors.join('\n'));
  log(`\nErrors written to reattach-verify-errors.txt`);
}
log(`\nFull output written to reattach-verify-complete.txt`);
