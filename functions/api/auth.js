/** 
 * Server-side authentication with rate limiting.
 * Password hash is stored in wrangler.toml (PASSWORD_HASH environment variable).
 * Rate limiting uses D1 database to track failed attempts by IP.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_SECONDS = 15 * 60; // 15 minutes

/** Hash a password using SHA-256 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Timing-safe string comparison to prevent timing attacks */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Get client IP from request headers (Cloudflare provides this) */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
         'unknown';
}

/** Ensure rate limit table exists in D1 */
async function ensureRateLimitTable(db) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        ip TEXT PRIMARY KEY,
        attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT 0,
        last_attempt INTEGER DEFAULT 0
      )
    `).run();
  } catch (e) {
    // Table might already exist, that's fine
    console.log('Rate limit table check:', e.message);
  }
}

/** Check and enforce rate limiting */
async function checkRateLimit(db, ip) {
  try {
    await ensureRateLimitTable(db);
    
    const now = Math.floor(Date.now() / 1000);
    const record = await db.prepare(
      'SELECT attempts, locked_until FROM rate_limits WHERE ip = ?'
    ).bind(ip).first();

    if (!record) return { allowed: true, remaining: MAX_ATTEMPTS };

    // Check if currently locked out
    if (record.locked_until > now) {
      const remainingSecs = record.locked_until - now;
      return { 
        allowed: false, 
        remaining: 0, 
        lockedFor: remainingSecs,
        message: `Too many failed attempts. Try again in ${Math.ceil(remainingSecs / 60)} minutes.`
      };
    }

    // If lockout has expired, reset
    if (record.locked_until > 0 && record.locked_until <= now) {
      await db.prepare(
        'UPDATE rate_limits SET attempts = 0, locked_until = 0 WHERE ip = ?'
      ).bind(ip).run();
      return { allowed: true, remaining: MAX_ATTEMPTS };
    }

    return { allowed: true, remaining: MAX_ATTEMPTS - record.attempts };
  } catch (e) {
    // If D1 fails, still allow the attempt (fail open for auth, rate limit is defense in depth)
    console.error('Rate limit check failed:', e);
    return { allowed: true, remaining: MAX_ATTEMPTS };
  }
}

/** Record a failed login attempt */
async function recordFailedAttempt(db, ip) {
  try {
    const now = Math.floor(Date.now() / 1000);
    
    // Upsert the attempt count
    const result = await db.prepare(
      'INSERT INTO rate_limits (ip, attempts, last_attempt) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1, last_attempt = ?'
    ).bind(ip, now, now).run();

    // Check if we need to lock
    const record = await db.prepare(
      'SELECT attempts FROM rate_limits WHERE ip = ?'
    ).bind(ip).first();

    if (record && record.attempts >= MAX_ATTEMPTS) {
      const lockUntil = now + LOCKOUT_DURATION_SECONDS;
      await db.prepare(
        'UPDATE rate_limits SET locked_until = ? WHERE ip = ?'
      ).bind(lockUntil, ip).run();
      return { locked: true, remaining: 0 };
    }

    return { locked: false, remaining: MAX_ATTEMPTS - (record?.attempts || 0) };
  } catch (e) {
    console.error('Failed to record attempt:', e);
    return { locked: false, remaining: MAX_ATTEMPTS };
  }
}

/** Clear rate limit record on successful login */
async function clearRateLimit(db, ip) {
  try {
    await db.prepare('DELETE FROM rate_limits WHERE ip = ?').bind(ip).run();
  } catch (e) {
    console.error('Failed to clear rate limit:', e);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const PASSWORD_HASH = env.PASSWORD_HASH;
  if (!PASSWORD_HASH) {
    return new Response('Security misconfiguration: PASSWORD_HASH not set', { status: 500 });
  }

  // Server-side rate limiting
  const clientIP = getClientIP(request);
  const db = env.DB;
  
  if (db) {
    const rateCheck = await checkRateLimit(db, clientIP);
    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({ 
        ok: false, 
        error: rateCheck.message,
        lockedFor: rateCheck.lockedFor 
      }), { 
        status: 429, 
        headers: { 
          'content-type': 'application/json',
          'Retry-After': String(rateCheck.lockedFor)
        } 
      });
    }
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const incomingPassword = body?.password;
  if (!incomingPassword || typeof incomingPassword !== 'string') {
    return new Response('Password required', { status: 400 });
  }

  // Limit password length to prevent DoS via hashing extremely long strings
  if (incomingPassword.length > 256) {
    return new Response('Password too long', { status: 400 });
  }

  try {
    const incomingHash = await hashPassword(incomingPassword);
    
    if (timingSafeEqual(incomingHash, PASSWORD_HASH)) {
      // Success — clear rate limit
      if (db) await clearRateLimit(db, clientIP);
      
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    
    // Failed — record attempt
    let lockInfo = { locked: false, remaining: MAX_ATTEMPTS };
    if (db) {
      lockInfo = await recordFailedAttempt(db, clientIP);
    }

    const responseBody = { ok: false };
    if (lockInfo.locked) {
      responseBody.error = 'Too many failed attempts. Account locked for 15 minutes.';
      responseBody.lockedFor = LOCKOUT_DURATION_SECONDS;
    } else if (lockInfo.remaining <= 2) {
      responseBody.remaining = lockInfo.remaining;
    }

    return new Response(JSON.stringify(responseBody), { 
      status: lockInfo.locked ? 429 : 401, 
      headers: { 'content-type': 'application/json' } 
    });
  } catch (e) {
    console.error('Auth error:', e);
    return new Response('Internal error', { status: 500 });
  }
}
