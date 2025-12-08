#!/usr/bin/env node
/**
 * Logger Test Script
 * 
 * This script demonstrates the environment-aware logging behavior.
 * Run with different NODE_ENV values to see the difference:
 * 
 *   NODE_ENV=development node test-logger.js
 *   NODE_ENV=production node test-logger.js
 */

// Mock Deno environment for Node.js testing
if (typeof Deno === 'undefined') {
  global.Deno = undefined;
}

// Import the logger (using CommonJS require for this test)
const path = require('path');
const fs = require('fs');

// Read and evaluate the logger module
const loggerPath = path.join(__dirname, 'functions', '_shared', 'logger.js');
const loggerCode = fs.readFileSync(loggerPath, 'utf-8');

// Convert ES module to work in Node.js test
const loggerModule = eval(`
  (function() {
    ${loggerCode.replace(/export /g, 'this.')}
    return this;
  }).call({})
`);

const { createLogger } = loggerModule;

console.log('='.repeat(60));
console.log('Logger Test - Environment:', process.env.NODE_ENV || 'development');
console.log('='.repeat(60));
console.log();

const logger = createLogger('test-module');

console.log('Testing DEBUG level (should only show in development):');
logger.debug('This is a debug message', { test: true });

console.log();
console.log('Testing INFO level (should only show in development):');
logger.info('This is an info message', { count: 42 });

console.log();
console.log('Testing WARN level (should always show):');
logger.warn('This is a warning message', { retry: 2 });

console.log();
console.log('Testing ERROR level (should always show):');
logger.error('This is an error message', { error: 'test error' });

console.log();
console.log('='.repeat(60));
console.log('Test complete!');
console.log('Expected behavior:');
console.log('  - In development: All 4 log messages appear');
console.log('  - In production: Only WARN and ERROR messages appear');
console.log('='.repeat(60));
