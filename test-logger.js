#!/usr/bin/env node
/**
 * Logger Test Script - Simple Demo
 * 
 * This script demonstrates the environment-aware logging behavior.
 * Run with different NODE_ENV values to see the difference:
 * 
 *   NODE_ENV=development node test-logger.js
 *   NODE_ENV=production node test-logger.js
 * 
 * Note: This is a simplified test for demonstration purposes.
 * The actual logger is designed for Deno/ES modules.
 */

console.log('='.repeat(60));
console.log('Logger Test - Environment:', process.env.NODE_ENV || 'development');
console.log('='.repeat(60));
console.log();

// Simulate logger behavior for testing
const isDevelopment = process.env.NODE_ENV !== 'production';

console.log('Testing DEBUG level (should only show in development):');
if (isDevelopment) {
  console.log('[DEMO] [DEBUG] [test-module] This is a debug message {"test":true}');
} else {
  console.log('  (suppressed in production)');
}

console.log();
console.log('Testing INFO level (should only show in development):');
if (isDevelopment) {
  console.log('[DEMO] [INFO] [test-module] This is an info message {"count":42}');
} else {
  console.log('  (suppressed in production)');
}

console.log();
console.log('Testing WARN level (should always show):');
console.log('[DEMO] [WARN] [test-module] This is a warning message {"retry":2}');

console.log();
console.log('Testing ERROR level (should always show):');
console.log('[DEMO] [ERROR] [test-module] This is an error message {"error":"test error"}');

console.log();
console.log('='.repeat(60));
console.log('Test complete!');
console.log('Expected behavior:');
console.log('  - In development: All 4 log messages appear');
console.log('  - In production: Only WARN and ERROR messages appear');
console.log('='.repeat(60));
console.log();
console.log('To test the actual logger, import it in a Deno/ES module context:');
console.log('  import { createLogger } from "./functions/_shared/logger.js";');

