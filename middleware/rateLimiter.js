const windows = new Map(); // IP → { count, resetAt }

/**
 * Creates a rate-limit middleware.
 * @param {number} maxRequests  – max allowed requests per window
 * @param {number} windowMs     – window size in milliseconds
 * @param {string} [message]    – optional custom error message
 */
function createLimiter(maxRequests, windowMs, message) {
  return (req, res, next) => {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';

    const now = Date.now();
    const entry = windows.get(ip);

    if (!entry || now > entry.resetAt) {
      // Fresh window
      windows.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({
        error: message || 'Too many requests. Please slow down.',
      });
    }

    next();
  };
}

// ── Pre-configured limiters ───────────────────────────────────────────────────

/** General API — 120 req / minute */
const generalLimiter = createLimiter(120, 60_000);

/** Auth-sensitive actions (create room, join) — 20 req / minute */
const strictLimiter = createLimiter(20, 60_000, 'Too many requests. Try again in a minute.');

/** Discovery listing — 60 req / minute */
const discoveryLimiter = createLimiter(60, 60_000);

/** Join-request actions — 10 req / minute (prevent spam requests) */
const joinRequestLimiter = createLimiter(10, 60_000, 'Too many join requests. Wait a moment.');

/** Report action — 5 reports / 10 minutes */
const reportLimiter = createLimiter(5, 10 * 60_000, 'Too many reports submitted.');

module.exports = {
  generalLimiter,
  strictLimiter,
  discoveryLimiter,
  joinRequestLimiter,
  reportLimiter,
};