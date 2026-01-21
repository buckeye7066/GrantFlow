/**
 * Health check endpoints for Railway healthcheck, Docker HEALTHCHECK, and monitoring.
 * These endpoints are mounted early in server setup to ensure they're always available.
 */
import express from 'express';
import fs from 'fs';

const router = express.Router();

/**
 * GET /api/health
 * Railway healthcheck endpoint - must return 200 when service is up.
 * Returns safe, minimal diagnostics without exposing secrets.
 */
router.get('/api/health', async (req, res) => {
  const db = req.db;
  
  try {
    const healthSummary = req.getSafeHealthSummary 
      ? await req.getSafeHealthSummary(db)
      : { status: 'healthy', timestamp: new Date().toISOString() };
    
    // Contract: public health endpoints must use { ok, warning, error } for status.
    // Some internal helpers may return { healthy, degraded, unhealthy } — normalize here.
    const rawStatus = String(healthSummary?.status ?? 'error').toLowerCase();
    const status =
      rawStatus === 'healthy'
        ? 'ok'
        : rawStatus === 'degraded'
          ? 'warning'
          : rawStatus === 'unhealthy'
            ? 'error'
            : rawStatus || 'error';

    // Treat "warning" as healthy for platform checks (Railway healthchecks, Docker HEALTHCHECK, etc.)
    // Only fail hard when the normalized status indicates a real error.
    const statusCode = status === 'error' ? 500 : 200;
    const body =
      rawStatus === status
        ? healthSummary
        : { ...healthSummary, status, legacy_status: rawStatus };

    res.status(statusCode).json(body);
  } catch (error) {
    console.error('[/api/health] Error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Failed to retrieve health information'
    });
  }
});

/**
 * GET /readyz
 * Docker HEALTHCHECK endpoint - returns 200 only when service is ready.
 * Checks DB reachability and uploads directory writability.
 */
router.get('/readyz', async (req, res) => {
  const db = req.db;
  const uploadsDir = req.uploadsDir;
  
  try {
    // Check database reachability
    if (db.healthcheck) {
      const hc = await db.healthcheck();
      if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed');
    } else {
      await db.prepare('SELECT 1 as ok').get();
    }
    
    // Ensure uploads dir is present and writable (production requires a volume).
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (e) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'uploads_dir_unwritable',
        uploads_dir: uploadsDir,
        message: e?.message || String(e),
        timestamp: new Date().toISOString(),
      });
    }
    
    res.status(200).json({ 
      status: 'ready', 
      dialect: db.dialect, 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    console.error('[/readyz] Not ready:', error);
    res.status(503).json({ 
      status: 'not_ready', 
      reason: 'database_unreachable', 
      timestamp: new Date().toISOString() 
    });
  }
});

/**
 * GET /health
 * Legacy health endpoint - alias for /api/health.
 * Kept for backward compatibility.
 */
router.get('/health', async (req, res) => {
  const db = req.db;
  
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {
      database: 'unknown',
      openai: 'unknown',
      anthropic: 'unknown',
    }
  };
  
  // Check database connection
  try {
    if (db.healthcheck) {
      const hc = await db.healthcheck();
      if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed');
    } else {
      await db.prepare('SELECT 1').get();
    }
    health.dependencies.database = 'healthy';
  } catch (error) {
    health.dependencies.database = 'unhealthy';
    health.status = 'degraded';
  }
  
  // Check if OpenAI API key is configured (safe check - no key exposure)
  const hasOpenAIKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  const hasAnthropicKey = Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim());
  health.dependencies.openai = hasOpenAIKey
    ? 'configured'
    : hasAnthropicKey
      ? 'fallback_anthropic_configured'
      : 'not configured';
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * GET /healthz
 * Kubernetes-style health endpoint - alias for /api/health.
 * Kept for compatibility with k8s-style monitoring.
 */
router.get('/healthz', async (req, res) => {
  const db = req.db;
  
  try {
    const healthSummary = req.getSafeHealthSummary 
      ? await req.getSafeHealthSummary(db)
      : { status: 'healthy', timestamp: new Date().toISOString() };
      
    const rawStatus = healthSummary?.status ?? 'error';
    const status =
      rawStatus === 'healthy'
        ? 'ok'
        : rawStatus === 'degraded'
          ? 'warning'
          : rawStatus === 'unhealthy'
            ? 'error'
            : rawStatus;

    const statusCode = status === 'error' ? 500 : 200;
    const body =
      rawStatus === status
        ? healthSummary
        : { ...healthSummary, status, legacy_status: rawStatus };

    res.status(statusCode).json(body);
  } catch (error) {
    console.error('[/healthz] Error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Failed to retrieve health information'
    });
  }
});

export default router;
