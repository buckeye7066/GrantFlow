import express from 'express'

const router = express.Router()

// Marketing stats for non-admin users
const MARKETING_STATS = {
  organizations: 3144,
  fundsSecured: 22515850,
  activeProfiles: 3144,
  opportunitiesFound: 15000,
}

/**
 * GET /api/stats/dashboard
 * Returns dashboard statistics based on user role
 * - Admin users see real database stats
 * - Regular users see marketing stats
 */
router.get('/dashboard', async (req, res) => {
  try {
    const isAdmin = Boolean(req.ctx?.isAdmin)

    if (isAdmin) {
      if (!req.db) {
        return res.status(500).json({
          error: 'Database not available',
          organizations: 0,
          fundsSecured: 0,
          activeProfiles: 0,
          opportunitiesFound: 0,
          isRealData: true,
        })
      }

      // Return real database stats for admin
      const profilesCount = await req.db
        .prepare('SELECT COUNT(*) as count FROM profiles')
        .get()
      
      const organizationsCount = await req.db
        .prepare('SELECT COUNT(*) as count FROM organizations')
        .get()
      
      const grantsCount = await req.db
        .prepare('SELECT COUNT(*) as count FROM grants')
        .get()
      
      const activePredicate = req.db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1'
      const opportunitiesCount = await req.db
        .prepare(`SELECT COUNT(*) as count FROM funding_opportunities WHERE ${activePredicate}`)
        .get()
      
      const awardedGrants = await req.db
        .prepare(`
          SELECT COALESCE(SUM(amount_awarded), 0) as total
          FROM grants
          WHERE status = 'awarded' AND amount_awarded > 0
        `)
        .get()
      
      const pipelineTotal = await req.db
        .prepare(`
          SELECT COALESCE(SUM(amount_requested), 0) as total
          FROM grants
          WHERE status IN ('interested', 'drafting', 'app_prep', 'revision', 'submitted', 'under_review')
        `)
        .get()

      return res.json({
        organizations: organizationsCount?.count ?? 0,
        fundsSecured: awardedGrants?.total ?? 0,
        activeProfiles: profilesCount?.count ?? 0,
        opportunitiesFound: opportunitiesCount?.count ?? 0,
        grantsTotal: grantsCount?.count ?? 0,
        pipelineTotal: pipelineTotal?.total ?? 0,
        isRealData: true,
      })
    }

    // Return marketing stats for regular users
    return res.json({
      ...MARKETING_STATS,
      isRealData: false,
    })
  } catch (error) {
    console.error('[stats/dashboard] Error:', error)
    return res.status(500).json({ 
      error: 'Failed to fetch dashboard stats',
      organizations: 0,
      fundsSecured: 0,
      activeProfiles: 0,
      opportunitiesFound: 0,
    })
  }
})

export default router
