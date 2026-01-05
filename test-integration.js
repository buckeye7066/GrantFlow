#!/usr/bin/env node
/**
 * Integration test for Claude API migration
 * This tests the structure without requiring actual API keys
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

console.log('🧪 Testing Claude API Integration...\n')

// Test 1: Check that Anthropic SDK is in dependencies
console.log('✓ Test 1: Checking backend/package.json for @anthropic-ai/sdk...')
const backendPkg = await import('./backend/package.json', { assert: { type: 'json' } })
if (backendPkg.default.dependencies['@anthropic-ai/sdk']) {
  console.log('  ✅ @anthropic-ai/sdk found in dependencies')
} else {
  console.error('  ❌ @anthropic-ai/sdk NOT found in dependencies')
  process.exit(1)
}

// Test 2: Check anyaOrchestrator imports Anthropic
console.log('\n✓ Test 2: Checking anyaOrchestrator.js imports...')
const orchestratorPath = join(__dirname, 'backend/services/anyaOrchestrator.js')
const orchestratorContent = await import('fs').then(fs => 
  fs.promises.readFile(orchestratorPath, 'utf-8')
)

if (orchestratorContent.includes("import Anthropic from '@anthropic-ai/sdk'")) {
  console.log('  ✅ Anthropic import found')
} else {
  console.error('  ❌ Anthropic import NOT found')
  process.exit(1)
}

if (orchestratorContent.includes('getClaudeClient')) {
  console.log('  ✅ getClaudeClient function found')
} else {
  console.error('  ❌ getClaudeClient function NOT found')
  process.exit(1)
}

if (orchestratorContent.includes('ANTHROPIC_API_KEY')) {
  console.log('  ✅ ANTHROPIC_API_KEY environment variable reference found')
} else {
  console.error('  ❌ ANTHROPIC_API_KEY environment variable reference NOT found')
  process.exit(1)
}

if (orchestratorContent.includes('claude.messages.create')) {
  console.log('  ✅ Claude Messages API usage found')
} else {
  console.error('  ❌ Claude Messages API usage NOT found')
  process.exit(1)
}

// Test 3: Check client.js has credentials: 'include'
console.log('\n✓ Test 3: Checking client.js auth improvements...')
const clientPath = join(__dirname, 'src/api/client.js')
const clientContent = await import('fs').then(fs => 
  fs.promises.readFile(clientPath, 'utf-8')
)

if (clientContent.includes("credentials: 'include'")) {
  console.log('  ✅ credentials: "include" found in refresh request')
} else {
  console.error('  ❌ credentials: "include" NOT found in refresh request')
  process.exit(1)
}

if (clientContent.includes('if (response.status === 401)')) {
  console.log('  ✅ Enhanced 401 error handling found')
} else {
  console.error('  ❌ Enhanced 401 error handling NOT found')
  process.exit(1)
}

// Test 4: Check .env.example has new variables
console.log('\n✓ Test 4: Checking .env.example for new variables...')
const envExamplePath = join(__dirname, '.env.example')
const envExampleContent = await import('fs').then(fs => 
  fs.promises.readFile(envExamplePath, 'utf-8')
)

if (envExampleContent.includes('ANTHROPIC_API_KEY')) {
  console.log('  ✅ ANTHROPIC_API_KEY found in .env.example')
} else {
  console.error('  ❌ ANTHROPIC_API_KEY NOT found in .env.example')
  process.exit(1)
}

if (envExampleContent.includes('ANYA_CLAUDE_MODEL')) {
  console.log('  ✅ ANYA_CLAUDE_MODEL found in .env.example')
} else {
  console.error('  ❌ ANYA_CLAUDE_MODEL NOT found in .env.example')
  process.exit(1)
}

console.log('\n✨ All integration tests passed!\n')
console.log('📝 Summary of changes:')
console.log('  • Auth token refresh now includes credentials')
console.log('  • Enhanced error handling for invalid refresh tokens')
console.log('  • Anya now uses Claude API instead of OpenAI')
console.log('  • Environment variables updated for Anthropic configuration')
console.log('\n🚀 Next steps:')
console.log('  1. Set ANTHROPIC_API_KEY in your .env file')
console.log('  2. (Optional) Set ANYA_CLAUDE_MODEL if you want a different model')
console.log('  3. Start the backend and test Anya responses')
console.log('  4. Test authentication flow with token refresh\n')
