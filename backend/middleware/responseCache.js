const cache = new Map();

// Clear expired entries periodically
let cleanupInterval;
function startCleanup() {
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp >= 30000) {
        cache.delete(key);
      }
    }
  }, 60000);
}
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
process.on('SIGTERM', stopCleanup);
process.on('SIGINT', stopCleanup);
startCleanup();

// Expose cache invalidation so mutation routes can purge stale entries
export function invalidateUserCache(userId) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      cache.delete(key);
    }
  }
}

export function responseCache(ttlMs = 30000) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    // req.originalUrl includes the path and query string, so it's a precise key
    // Key must include user identity to prevent cross-user cache poisoning
    // and must be invalidated externally on profile/opportunity mutations.
    const userId = req.user?.id ?? req.headers['x-user-id'];
if (!userId) return next(); // Never cache unauthenticated requests
    const key = `${userId}:${req.originalUrl}`;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < ttlMs) {
      res.set('X-Cache', 'HIT');
      console.debug(`[responseCache] HIT key=${key} age=${Date.now() - cached.timestamp}ms`);
      res.json(cached.data);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = function cachedJson(data) {
      res.json = originalJson; // restore immediately to prevent re-entrant patching
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (cache.size >= 500) {
          cache.delete(cache.keys().next().value);
        }
        cache.set(key, { data, timestamp: Date.now() });
        console.debug(`[responseCache] MISS+SET key=${key}`);
      }
      return originalJson(data);
    };

    next();
  };
}
