#!/usr/bin/env node
/**
 * Diagnose Anya AI Connection Issues
 * Usage: node scripts/diagnose-anya.mjs
 */

import fetch from 'node-fetch'
import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import process from 'process'

import { redactSecret, resolveAdminToken } from './_lib/secrets.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load environment variables
config({ path: path.join(__dirname, '../.env') })
config({ path: path.join(__dirname, '../backend/.env') })

const API_URL = process.env.API_URL || 'https://grantflow-production.up.railway.app'
let ADMIN_TOKEN = null
try {
  ADMIN_TOKEN = resolveAdminToken({ required: true })
} catch (err) {
  console.error('[diagnose-anya] Missing admin token. Set ADMIN_TOKEN or ANYA_ADMIN_TOKEN.')
  process.exit(1)
}

console.log('=== Anya AI Connection Diagnosis ===\n')

// Step 1: Check local environment
console.log('1. Local Environment Check:')
console.log('   ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `✅ Set (${redactSecret()})` : '❌ Missing')
console.log('   Key format:', process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-') ? 
  '✅ Correct' : '⚠️  Should start with sk-ant-')
console.log()

// Step 2: Test direct Anthropic API
if (process.env.ANTHROPIC_API_KEY) {
  console.log('2. Direct Anthropic API Test:')
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'Reply with just "ok"' }],
        max_tokens: 10,
      }),
    })
    
    if (response.ok) {
      const data = await response.json()
      console.log('   ✅ API Key is VALID')
      console.log('   Response:', data.content?.[0]?.text || 'Success')
    } else {
      const errorText = await response.text()
      console.log('   ❌ API Key is INVALID or there\'s an API issue')
      console.log('   Status:', response.status)
      console.log('   Error:', String(errorText || '').slice(0, 200))
      
      if (response.status === 401) {
        console.log('\n   💡 Solution: Your API key is invalid. Get a new one from https://console.anthropic.com/')
      } else if (response.status === 429) {
        console.log('\n   💡 Solution: Rate limited. Wait a moment or upgrade your plan.')
      }
    }
  } catch (error) {
    console.log('   ❌ Connection Failed:', error.message)
    console.log('\n   💡 Solution: Check your internet connection')
  }
} else {
  console.log('2. Skipping Anthropic API test (no key set locally)')
}
console.log()

// Step 3: Test Anya endpoint status
console.log('3. Testing Anya Status Endpoint:')
try {
  const response = await fetch(`${API_URL}/api/anya/status`, {
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
    },
  })
  
  if (response.ok) {
    const data = await response.json()
    console.log('   Endpoint Status:', data.status)
    console.log('   Anthropic Status:', data.anthropic?.status || 'Unknown')
    console.log('   API Key in Railway:', data.anthropic?.api_key_configured ? '✅ Set (redacted)' : '❌ Not set')
    
    if (data.anthropic?.error) {
      console.log('\n   ❌ Error Details:')
      console.log('   Type:', data.anthropic.error.type)
      console.log('   Message:', data.anthropic.error.message)
      console.log('   Hint:', data.anthropic.error.hint)
    }
    
    if (data.anthropic?.model) {
      console.log('\n   ✅ Test successful!')
      console.log('   Model:', data.anthropic.model.model)
      console.log('   Test response:', data.anthropic.model.test_response)
    }
  } else {
    console.log('   ❌ Failed to reach Anya endpoint')
    console.log('   Status:', response.status)
  }
} catch (error) {
  console.log('   ❌ Connection to Railway failed:', error.message)
  console.log('\n   💡 Solution: Check if Railway is deployed and running')
}
console.log()

// Step 4: Test actual message sending
console.log('4. Testing Anya Message:')
try {
  // First create a session
  const sessionResponse = await fetch(`${API_URL}/api/anya/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Diagnostic Test' }),
  })
  
  if (sessionResponse.ok) {
    const session = await sessionResponse.json()
    console.log('   ✅ Session created:', session.id)
    
    // Send a test message
    const messageResponse = await fetch(`${API_URL}/api/anya/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello, are you connected to AI?' }),
    })
    
    if (messageResponse.ok) {
      const result = await messageResponse.json()
      const assistantReply = result.assistant?.content || result.content || 'No response'
      console.log('   Anya replied:', String(assistantReply || '').slice(0, 100) + '...')
      
      if (assistantReply.includes('trouble reaching') || assistantReply.includes('without an AI model')) {
        console.log('\n   ❌ Anya is in fallback mode (no AI)')
      } else {
        console.log('\n   ✅ Anya is connected to AI!')
      }
    }
  }
} catch (error) {
  console.log('   ❌ Failed to test message:', error.message)
}

console.log('\n=== Diagnosis Summary ===')
console.log('\nTo fix Anya AI connection:')
console.log('1. Get an API key from https://console.anthropic.com/')
console.log('2. Add to Railway: ANTHROPIC_API_KEY=sk-ant-...')
console.log('3. Railway will auto-redeploy')
console.log('4. Test again with this script')
console.log('\nNeed help? Check ANYA_AI_SETUP.md for detailed instructions.')