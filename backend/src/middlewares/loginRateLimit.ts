import type { RequestHandler } from "express";

/**
 * Brute-force protection for POST /auth/login.
 *
 * Counts FAILED logins (HTTP 401) in two buckets:
 *   - per username — stops password guessing against one account, even when the
 *     attacker rotates IPs;
 *   - per client IP — stops one machine spraying many usernames.
 * Once a bucket reaches its limit, further attempts get 429 until the window
 * (started at that bucket's first failure) expires. A successful login clears that
 * username's bucket, so a user who mistypes a few times and then gets it right starts
 * fresh. Successful logins never count, so an office sharing one NAT IP is unaffected.
 *
 * State is in process memory: it resets on restart and is per-instance. That fits
 * the current single-API-container deployment; move it to a shared store if the API
 * ever runs as more than one replica.
 */

export interface LoginRateLimitOptions {
  windowMs?: number;
  maxFailuresPerUsername?: number;
  maxFailuresPerIp?: number;
  now?: () => number;
}

interface Bucket {
  failures: number;
  resetAt: number;
}

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  maxFailuresPerUsername: 5,
  maxFailuresPerIp: 20,
};

// Bound memory if someone floods random usernames; expired buckets are swept first.
const MAX_TRACKED_KEYS = 50_000;

export function createLoginRateLimiter(options: LoginRateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const maxPerUser = options.maxFailuresPerUsername ?? DEFAULTS.maxFailuresPerUsername;
  const maxPerIp = options.maxFailuresPerIp ?? DEFAULTS.maxFailuresPerIp;
  const now = options.now ?? Date.now;

  const buckets = new Map<string, Bucket>();

  function liveBucket(key: string, at: number): Bucket | undefined {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= at) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  function sweep(at: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
    // Still full of live keys: drop the oldest-inserted ones rather than grow unbounded.
    while (buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  function recordFailure(key: string, at: number) {
    const bucket = liveBucket(key, at);
    if (bucket) {
      bucket.failures += 1;
      return;
    }
    if (buckets.size >= MAX_TRACKED_KEYS) sweep(at);
    buckets.set(key, { failures: 1, resetAt: at + windowMs });
  }

  return (request, response, next) => {
    const at = now();
    const rawUsername = (request.body as { username?: unknown } | undefined)?.username;
    const username =
      typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
    const userKey = username ? `u:${username}` : null;
    const ipKey = `ip:${request.ip ?? "unknown"}`;

    const userBucket = userKey ? liveBucket(userKey, at) : undefined;
    const ipBucket = liveBucket(ipKey, at);
    const blockedUntil = Math.max(
      userBucket && userBucket.failures >= maxPerUser ? userBucket.resetAt : 0,
      ipBucket && ipBucket.failures >= maxPerIp ? ipBucket.resetAt : 0,
    );

    if (blockedUntil > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - at) / 1000));
      const minutes = Math.ceil(retryAfterSeconds / 60);
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        error: {
          code: "TOO_MANY_LOGIN_ATTEMPTS",
          message: `Too many failed login attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          details: null,
        },
      });
      return;
    }

    response.on("finish", () => {
      const finishedAt = now();
      if (response.statusCode === 401) {
        if (userKey) recordFailure(userKey, finishedAt);
        recordFailure(ipKey, finishedAt);
      } else if (response.statusCode >= 200 && response.statusCode < 300 && userKey) {
        buckets.delete(userKey);
      }
    });

    next();
  };
}

export const loginRateLimiter = createLoginRateLimiter();
