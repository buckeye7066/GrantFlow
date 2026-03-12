const cache = new Map();

export function responseCache(ttlMs = 30000) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    // req.originalUrl includes the path and query string, so it's a precise key
    const key = req.originalUrl;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < ttlMs) {
      return res.json(cached.data);
    }

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      cache.set(key, { data, timestamp: Date.now() });
      // Prevent unbounded cache growth: evict the oldest entry when the limit is reached
      if (cache.size > 500) {
        cache.delete(cache.keys().next().value);
      }
      return originalJson(data);
    };

    next();
  };
}
