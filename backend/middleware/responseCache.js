const cache = new Map();

// Clear expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp >= 30000) {
      cache.delete(key);
    }
  }
}, 60000);

export function responseCache(ttlMs = 30000) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    // req.originalUrl includes the path and query string, so it's a precise key
    const key = req.originalUrl;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < ttlMs) {
      res.json(cached.data);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Prevent unbounded cache growth: evict the oldest entry when the limit is reached
      if (cache.size >= 500) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(key, { data, timestamp: Date.now() });
      return originalJson(data);
    };

    next();
  };
}
