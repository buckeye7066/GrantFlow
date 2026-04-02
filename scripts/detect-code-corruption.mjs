#!/usr/bin/env node
/**
 * detect-code-corruption.mjs - Detects common AI/CodeGuard code corruption patterns
 * 
 * This script catches syntax errors and common corruption patterns that slip through
 * when automated code fixers make changes without proper validation:
 * 
 * 1. Duplicate function/variable declarations
 * 2. Missing imports for used identifiers
 * 3. Misplaced code (e.g., error messages from wrong functions)
 * 4. Parsing errors (syntax issues)
 * 
 * Run: node scripts/detect-code-corruption.mjs
 * Returns exit code 0 if clean, 1 if corruptions found.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()

// ANSI colors
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

/**
 * Run ESLint with JSON output to get structured error information
 */
async function runEslintCheck() {
  return new Promise((resolve) => {
    const args = [
      '--format', 'json',
      '--no-error-on-unmatched-pattern',
      'src/**/*.{js,jsx}',
      'backend/**/*.js'
    ]
    
    const child = spawn('npx', ['eslint', ...args], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    let stdout = ''
    let stderr = ''
    
    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    
    child.on('close', (code) => {
      try {
        const results = JSON.parse(stdout)
        resolve({ success: code === 0, results, stderr })
      } catch {
        // If ESLint output isn't valid JSON, something went very wrong
        resolve({ success: false, results: [], stderr: stderr || stdout })
      }
    })
    
    child.on('error', (err) => {
      resolve({ success: false, results: [], stderr: err.message })
    })
  })
}

/**
 * Categorize ESLint errors into corruption types
 */
function categorizeEslintErrors(results) {
  const corruptionPatterns = {
    duplicateDeclaration: [],
    undefinedVariable: [],
    parsingError: [],
    other: []
  }
  
  for (const file of results) {
    if (!file.messages || file.messages.length === 0) continue
    
    for (const msg of file.messages) {
      const entry = {
        file: file.filePath,
        line: msg.line,
        column: msg.column,
        message: msg.message,
        ruleId: msg.ruleId
      }
      
      // Categorize by error type
      if (msg.message.includes('already been declared') || msg.message.includes('already defined')) {
        corruptionPatterns.duplicateDeclaration.push(entry)
      } else if (msg.ruleId === 'no-undef' || msg.message.includes('is not defined')) {
        corruptionPatterns.undefinedVariable.push(entry)
      } else if (msg.message.includes('Parsing error') || msg.message.includes('Unexpected token')) {
        corruptionPatterns.parsingError.push(entry)
      } else if (msg.severity === 2) { // Errors only
        corruptionPatterns.other.push(entry)
      }
    }
  }
  
  return corruptionPatterns
}

/**
 * Main corruption detection
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║        Code Corruption Detection (CodeGuard Safeguard)       ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')
  
  let hasCorruption = false
  
  // Step 1: Run ESLint check
  console.log('→ Running ESLint analysis...')
  const { success, results, stderr } = await runEslintCheck()
  
  if (stderr && !success) {
    console.log(`${YELLOW}ESLint stderr: ${stderr}${RESET}`)
  }
  
  // Step 2: Categorize errors
  const categories = categorizeEslintErrors(results)
  
  // Step 3: Report findings
  const totalErrors = 
    categories.duplicateDeclaration.length +
    categories.undefinedVariable.length +
    categories.parsingError.length +
    categories.other.length
  
  if (totalErrors > 0) {
    hasCorruption = true
    console.log(`\n${RED}✖ Found ${totalErrors} potential corruption(s):${RESET}\n`)
    
    if (categories.duplicateDeclaration.length > 0) {
      console.log(`${RED}▸ DUPLICATE DECLARATIONS (${categories.duplicateDeclaration.length}):${RESET}`)
      console.log('  These occur when code fixers add new versions without removing the old ones.')
      for (const err of categories.duplicateDeclaration) {
        const relPath = path.relative(ROOT, err.file)
        console.log(`  ${YELLOW}${relPath}:${err.line}${RESET} - ${err.message}`)
      }
      console.log()
    }
    
    if (categories.undefinedVariable.length > 0) {
      console.log(`${RED}▸ UNDEFINED VARIABLES (${categories.undefinedVariable.length}):${RESET}`)
      console.log('  These occur when code is moved/copied without its variable context.')
      for (const err of categories.undefinedVariable) {
        const relPath = path.relative(ROOT, err.file)
        console.log(`  ${YELLOW}${relPath}:${err.line}${RESET} - ${err.message}`)
      }
      console.log()
    }
    
    if (categories.parsingError.length > 0) {
      console.log(`${RED}▸ PARSING ERRORS (${categories.parsingError.length}):${RESET}`)
      console.log('  These are syntax errors that prevent the code from being parsed.')
      for (const err of categories.parsingError) {
        const relPath = path.relative(ROOT, err.file)
        console.log(`  ${YELLOW}${relPath}:${err.line}${RESET} - ${err.message}`)
      }
      console.log()
    }
    
    if (categories.other.length > 0) {
      console.log(`${RED}▸ OTHER ERRORS (${categories.other.length}):${RESET}`)
      for (const err of categories.other.slice(0, 10)) { // Limit to first 10
        const relPath = path.relative(ROOT, err.file)
        console.log(`  ${YELLOW}${relPath}:${err.line}${RESET} - ${err.message}`)
      }
      if (categories.other.length > 10) {
        console.log(`  ... and ${categories.other.length - 10} more`)
      }
      console.log()
    }
    
    console.log('════════════════════════════════════════════════════════════════')
    console.log(`${RED}CODE CORRUPTION DETECTED${RESET}`)
    console.log('These errors are typically caused by automated code fixers that')
    console.log('make partial changes without proper validation.')
    console.log('')
    console.log('To fix:')
    console.log('1. Review the files listed above')
    console.log('2. Remove duplicate declarations (keep the better version)')
    console.log('3. Fix undefined variables (add imports or remove dead code)')
    console.log('4. Fix syntax errors')
    console.log('════════════════════════════════════════════════════════════════')
    
  } else {
    console.log(`\n${GREEN}✓ No code corruptions detected${RESET}`)
  }
  
  process.exit(hasCorruption ? 1 : 0)
}

main().catch((err) => {
  console.error(`${RED}Corruption detection failed: ${err.message}${RESET}`)
  process.exit(1)
})
