const ADMIN_PASSWORD = 'jnu8484';

const DEFAULT_STATE = {
  quizTitle: 'Annual Knowledge Quiz',
  quizDescription:
    'Teams compete in timed rounds. Scores reflect correct answers and speed bonuses. Final rankings are updated live.',
  teams: [
    {
      id: 'team-north-star',
      name: 'North Star',
      members: ['Alex Kim', 'Jordan Lee', 'Sam Patel'],
      score: 42,
    },
    {
      id: 'team-blue-shift',
      name: 'Blue Shift',
      members: ['Riley Chen', 'Morgan Wu', 'Casey Ortiz'],
      score: 38,
    },
    {
      id: 'team-vertex',
      name: 'Vertex',
      members: ['Taylor Brooks', 'Jamie Singh', 'Quinn Moore'],
      score: 35,
    },
  ],
};

function newNormalizeState(parsed) {
  const fallback = DEFAULT_STATE;
  if (!parsed || typeof parsed !== 'object') return fallback;
  const rawTeams = Array.isArray(parsed.teams) ? parsed.teams : fallback.teams;
  return {
    quizTitle: parsed.quizTitle ?? fallback.quizTitle,
    quizDescription: parsed.quizDescription ?? fallback.quizDescription,
    teams: rawTeams.map((t) => ({
      id: t && t.id ? String(t.id) : String(Date.now() + Math.random()),
      name: t && 'name' in t ? String(t.name ?? '') : '',
      members: Array.isArray(t?.members) ? t.members.slice(0, 3).map(String) : ['', '', ''],
      score: Number(t?.score) || 0,
    })),
  };
}

async function getOrInitState(db) {
  const row = await db.prepare('SELECT data FROM leaderboard_state WHERE id = ?').bind(1).first();
  if (row?.data) return JSON.parse(row.data);

  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO leaderboard_state (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
    )
    .bind(1, JSON.stringify(DEFAULT_STATE), now)
    .run();

  return DEFAULT_STATE;
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return new Response('D1 binding DB is not configured', { status: 500 });

  if (request.method === 'GET') {
    const state = await getOrInitState(db);
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (request.method === 'POST') {
    let body = null;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const password = body?.password;
    if (password !== ADMIN_PASSWORD) return new Response('Unauthorized', { status: 401 });

    const nextState = newNormalizeState(body?.state);
    const now = new Date().toISOString();
    const json = JSON.stringify(nextState);

    const upd = await db.prepare('UPDATE leaderboard_state SET data = ?, updated_at = ? WHERE id = ?').bind(json, now, 1).run();
    if (upd?.success === false) {
      // Some D1 result shapes don’t include "success". Treat as failure to update.
      return new Response('Failed to update state', { status: 500 });
    }
    if (typeof upd?.changes === 'number' && upd.changes === 0) {
      await db.prepare('INSERT INTO leaderboard_state (id, data, updated_at) VALUES (?, ?, ?)').bind(1, json, now).run();
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}

