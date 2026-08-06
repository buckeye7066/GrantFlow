#!/usr/bin/env node
/**
 * Check Anya's operational status against an explicitly selected deployment.
 *
 * Required env:
 * - ANYA_CHECK_API_BASE
 * - ANYA_CHECK_ADMIN_TOKEN
 */

import axios from 'axios'
import process from 'node:process'

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; refusing to contact an implicit deployment`)
  return value
}

function validatedBaseUrl(value) {
  const url = new URL(value)
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('ANYA_CHECK_API_BASE must use HTTPS unless it targets loopback')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ANYA_CHECK_API_BASE must not contain credentials, query parameters, or a fragment')
  }
  return url.toString().replace(/\/$/, '')
}

const API_BASE = validatedBaseUrl(requiredEnv('ANYA_CHECK_API_BASE'))
const ADMIN_TOKEN = requiredEnv('ANYA_CHECK_ADMIN_TOKEN')
const AUTH_HEADERS = Object.freeze({ Authorization: `Bearer ${ADMIN_TOKEN}` })

function responseIsCanonicalAdmin(data) {
  return data?.user?.is_admin === true || data?.role === 'admin'
}

async function checkAnyaStatus() {
  console.log('\n' + '='.repeat(50))
  console.log('   🤖 ANYA OPERATIONAL STATUS CHECK')
  console.log('='.repeat(50))

  try {
    console.log('\n📡 Checking server...')
    await axios.get(`${API_BASE}/health`)
    console.log('✅ Server is running')

    console.log('\n🔧 Environment Configuration:')
    console.log(`  ANYA_AUTONOMOUS_ENABLED: ${process.env.ANYA_AUTONOMOUS_ENABLED || 'not set'}`)
    console.log(`  ANYA_RUN_ON_STARTUP: ${process.env.ANYA_RUN_ON_STARTUP || 'not set'}`)

    console.log('\n🔐 Verifying canonical admin authority...')
    const authMe = await axios.get(`${API_BASE}/api/auth/me`, { headers: AUTH_HEADERS })
    if (!responseIsCanonicalAdmin(authMe.data)) {
      throw new Error('ANYA_CHECK_ADMIN_TOKEN did not resolve to a canonical server admin')
    }
    console.log('✅ Canonical admin authority verified')

    console.log('\n🤖 Checking Anya Services:')
    try {
      const tools = await axios.get(`${API_BASE}/api/anya/tools`, { headers: AUTH_HEADERS })
      console.log(`✅ Anya Tools Available: ${tools.data.tools.length}`)
      const keyTools = ['admin.anya.runCrawlers', 'admin.anya.testFunctions', 'admin.anya.runAutonomous']
      keyTools.forEach((tool) => {
        if (tools.data.tools.find((entry) => entry.name === tool)) console.log(`   ✓ ${tool}`)
      })
    } catch {
      console.log('❌ Anya tools endpoint not accessible')
    }

    console.log('\n📊 Checking Crawler Status:')
    try {
      const crawlers = await axios.get(`${API_BASE}/api/crawlers/jobs`, { headers: AUTH_HEADERS })
      console.log(`✅ Crawler Jobs: ${crawlers.data.length}`)
      const statusCounts = {}
      crawlers.data.forEach((job) => {
        statusCounts[job.status] = (statusCounts[job.status] || 0) + 1
      })
      Object.entries(statusCounts).forEach(([status, count]) => console.log(`   ${status}: ${count}`))
    } catch {
      console.log('❌ Crawler status not accessible')
    }

    console.log('\n🚀 Startup Operations:')
    try {
      const logs = await axios.get(`${API_BASE}/api/admin/logs?limit=10`, { headers: AUTH_HEADERS })
      const anyaLogs = logs.data.filter(
        (log) => log.message?.includes('Anya') || log.message?.includes('autonomous'),
      )
      if (anyaLogs.length > 0) {
        console.log('✅ Anya startup operations detected')
        anyaLogs.slice(0, 3).forEach((log) => console.log(`   • ${log.message.substring(0, 60)}...`))
      } else {
        console.log('⚠️ No Anya startup operations detected')
      }
    } catch {
      console.log('⚠️ Could not check logs')
    }

    console.log('\n' + '='.repeat(50))
    if (process.env.ANYA_AUTONOMOUS_ENABLED === 'true') {
      console.log('🎉 ANYA IS FULLY AUTONOMOUS AND OPERATIONAL!')
    } else {
      console.log('⚠️  Anya is operational but NOT autonomous')
    }
    console.log('='.repeat(50))
  } catch (error) {
    console.error('\n❌ Error checking Anya status:', error.message)
    process.exitCode = 1
  }
}

checkAnyaStatus()
