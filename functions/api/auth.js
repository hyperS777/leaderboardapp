/** Password hash is stored in wrangler.toml (PASSWORD_HASH environment variable) */

/** Hash a password using SHA-256 (for Node.js/Cloudflare) */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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

  let body = null;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const incomingPassword = body?.password;
  if (!incomingPassword) {
    return new Response('Password required', { status: 400 });
  }

  try {
    const incomingHash = await hashPassword(incomingPassword);
    
    if (incomingHash === PASSWORD_HASH) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('Auth error:', e);
    return new Response('Internal error', { status: 500 });
  }
}
