#!/bin/bash
# Nationwide Crawler Status Monitor
# Run this to check the progress of the crawler

echo "==================================================================="
echo "NATIONWIDE CRAWLER STATUS"
echo "==================================================================="
echo ""

# Check if crawler is running
if ps aux | grep -v grep | grep "nationwide-comprehensive-crawl" > /dev/null; then
    echo "✅ Crawler Status: RUNNING"
    echo ""
    
    # Get latest progress from log
    echo "Latest Progress:"
    tail -5 /home/runner/work/GrantFlow/GrantFlow/crawler-output.log
    echo ""
    
    # Check database stats
    cd /home/runner/work/GrantFlow/GrantFlow
    node -e "
    const Database = require('better-sqlite3');
    const db = new Database('./backend/data/grantflow.db');
    const count = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get();
    console.log('Total Opportunities Created:', count.count.toLocaleString());
    
    // Calculate progress
    const zipCount = 43859;
    const avgPerZip = 3;
    const expectedTotal = zipCount * avgPerZip;
    const progress = ((count.count / expectedTotal) * 100).toFixed(2);
    console.log('Expected Total:', expectedTotal.toLocaleString());
    console.log('Progress:', progress + '%');
    
    db.close();
    "
else
    echo "⏸️  Crawler Status: NOT RUNNING"
    echo ""
    echo "Check if crawler completed by looking at crawler-output.log:"
    tail -20 /home/runner/work/GrantFlow/GrantFlow/crawler-output.log
fi

echo ""
echo "==================================================================="
echo "Monitor live: tail -f /home/runner/work/GrantFlow/GrantFlow/crawler-output.log"
echo "==================================================================="
