#!/usr/bin/env node
/**
 * Check Anya's operational status
 */

import axios from 'axios'

const API_BASE = 'http://localhost:8080'

async function checkAnyaStatus() {
  console.log('\n' + '='.repeat(50))
  console.log('   🤖 ANYA OPERATIONAL STATUS CHECK')
  console.log('='.repeat(50))
  
  try {
    // 1. Check if server is running
    console.log('\n📡 Checking server...')
    const health = await axios.get(`${API_BASE}/health`)
    console.log('✅ Server is running')
    
    // 2. Check environment
    console.log('\n🔧 Environment Configuration:')
    console.log(`  ANYA_AUTONOMOUS_ENABLED: ${process.env.ANYA_AUTONOMOUS_ENABLED || 'not set'}`)
    console.log(`  ANYA_RUN_ON_STARTUP: ${process.env.ANYA_RUN_ON_STARTUP || 'not set'}`)
    
    // 3. Authenticate as admin
    console.log('\n🔐 Authenticating...')
    const authStart = await axios.post(`${API_BASE}/api/auth/email/start`, {
      email: 'buckeye7066@gmail.com'
    })
    
    const authVerify = await axios.post(`${API_BASE}/api/auth/email/verify`, {
      email: 'buckeye7066@gmail.com',
      code: authStart.data.previewCode
    })
    
    const token = authVerify.data.accessToken
    console.log('✅ Authenticated as admin')
    
    // 4. Check Anya endpoints
    console.log('\n🤖 Checking Anya Services:')
    
    try {
      const tools = await axios.get(`${API_BASE}/api/anya/tools`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      console.log(`✅ Anya Tools Available: ${tools.data.tools.length}`)
      
      // List some key tools
      const keyTools = ['admin.anya.runCrawlers', 'admin.anya.testFunctions', 'admin.anya.runAutonomous']
      keyTools.forEach(tool => {
        if (tools.data.tools.find(t => t.name === tool)) {
          console.log(`   ✓ ${tool}`)
        }
      })
    } catch (e) {
      console.log('❌ Anya tools endpoint not accessible')
    }
    
    // 5. Check crawler status
    console.log('\n📊 Checking Crawler Status:')
    try {
      const crawlers = await axios.get(`${API_BASE}/api/crawlers/jobs`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      console.log(`✅ Crawler Jobs: ${crawlers.data.length}`)
      
      // Count by status
      const statusCounts = {}
      crawlers.data.forEach(job => {
        statusCounts[job.status] = (statusCounts[job.status] || 0) + 1
      })
      
      Object.entries(statusCounts).forEach(([status, count]) => {
        console.log(`   ${status}: ${count}`)
      })
    } catch (e) {
      console.log('❌ Crawler status not accessible')
    }
    
    // 6. Check if Anya ran on startup
    console.log('\n🚀 Startup Operations:')
    try {
      const logs = await axios.get(`${API_BASE}/api/admin/logs?limit=10`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      
      const anyaLogs = logs.data.filter(log => 
        log.message?.includes('Anya') || 
        log.message?.includes('autonomous')
      )
      
      if (anyaLogs.length > 0) {
        console.log('✅ Anya startup operations detected')
        anyaLogs.slice(0, 3).forEach(log => {
          console.log(`   • ${log.message.substring(0, 60)}...`)
        })
      } else {
        console.log('⚠️ No Anya startup operations detected')
      }
    } catch (e) {
      console.log('⚠️ Could not check logs')
    }
    
    // Final Status
    console.log('\n' + '='.repeat(50))
    if (process.env.ANYA_AUTONOMOUS_ENABLED === 'true') {
      console.log('🎉 ANYA IS FULLY AUTONOMOUS AND OPERATIONAL!')
    } else {
      console.log('⚠️  Anya is operational but NOT autonomous')
      console.log('    Run: .\\start-anya-autonomous.ps1 to enable')
    }
    console.log('='.repeat(50))
    
  } catch (error) {
    console.error('\n❌ Error checking Anya status:', error.message)
    console.log('\nMake sure the server is running:')
    console.log('  npm run dev:full')
  }
}

// Run the check
checkAnyaStatus()