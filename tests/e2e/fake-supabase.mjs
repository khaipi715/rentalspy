// TEST ONLY. A tiny stand-in for the Supabase API (auth + REST) used to test the website end to end
// without Docker. Every request runs inside real Postgres as the real role (anon/authenticated) with the
// JWT claims set exactly like Supabase does, so the migration's row-level security is what's being tested.
// Supports only what the site uses: anonymous sign-up, rpc calls, select with eq filters/order/limit and an
// embedded comments(...) select, insert (with return), delete.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.PORT || 54321);
const SECRET = 'test-secret-not-for-production';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export const sign = (claims) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(claims);
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const verify = (t) => {
  const [h, p, s] = (t || '').split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  return JSON.parse(Buffer.from(p, 'base64url').toString());
};
export const ANON_KEY = sign({ role: 'anon', iss: 'fake', exp: 4102444800 });

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error('bad identifier ' + s), { status: 400 }); return '"' + s + '"'; };

async function asRole(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: user.id, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, is_anonymous: true, session_id: crypto.randomUUID() };
  return { access_token: sign(claims), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: crypto.randomUUID(),
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: '', phone: '', is_anonymous: true, app_metadata: { provider: 'anonymous' }, user_metadata: {}, identities: [], created_at: new Date().toISOString() } };
}

function parseFilters(url) {
  const where = [], vals = [];
  let order = '', limit = '', select = '*';
  for (const [k, v] of url.searchParams) {
    if (k === 'select') select = v;
    else if (k === 'order') { const [col, dir] = v.split('.'); order = ` order by ${ident(col)} ${dir === 'desc' ? 'desc' : 'asc'}`; }
    else if (k === 'limit') limit = ` limit ${Number(v) | 0}`;
    else if (k === 'columns' || k === 'on_conflict') continue;
    else { const m = v.match(/^eq\.(.*)$/); if (!m) throw Object.assign(new Error('unsupported filter ' + v), { status: 400 }); vals.push(m[1]); where.push(`${ident(k)} = $${vals.length}`); }
  }
  return { where: where.length ? ' where ' + where.join(' and ') : '', vals, order, limit, select };
}

async function selectRows(c, table, f) {
  const embed = f.select.match(/comments\(([^)]*)\)/);
  const r = await c.query(`select * from public.${ident(table)}${f.where}${f.order}${f.limit}`, f.vals);
  if (embed) for (const row of r.rows) {
    const cols = embed[1].split(',').map(ident).join(',');
    const cr = await c.query(`select ${cols} from public.comments where entry_id = $1`, [row.id]);
    row.comments = cr.rows[0] || null; // one-to-one (entry_id is the primary key)
  }
  return r.rows;
}

const pgErr = (e) => {
  const map = { '23505': 409, '23514': 400, 'P0001': 400, '42501': 401, '22P02': 400, '23503': 409 };
  return { status: e.status || map[e.code] || 400, body: { code: e.code || 'PGRST', message: e.message, details: e.detail || null, hint: null } };
};

const server = http.createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204);
  const url = new URL(req.url, 'http://x');
  let raw = ''; for await (const ch of req) raw += ch;
  const body = raw ? JSON.parse(raw) : {};
  const claims = verify((req.headers.authorization || '').replace(/^Bearer /, '')) || { role: 'anon' };
  try {
    // ---- auth
    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      const id = crypto.randomUUID();
      await pool.query('insert into auth.users (id, is_anonymous) values ($1, true)', [id]);
      return send(200, session({ id }));
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      if (claims.role !== 'authenticated') return send(401, { message: 'not signed in' });
      return send(200, session({ id: claims.sub }).user);
    }
    if (url.pathname === '/auth/v1/logout') return send(204);
    if (url.pathname.startsWith('/auth/v1/')) return send(400, { message: 'not supported in the test server' });
    // ---- rest
    const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
    if (!m) return send(404, { message: 'not found' });
    const [, rpc, name] = m;
    const single = (req.headers.accept || '').includes('vnd.pgrst.object');
    const out = await asRole(claims, async (c) => {
      if (rpc) {
        const keys = Object.keys(body);
        const args = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
        const r = await c.query(`select * from public.${ident(name)}(${args})`, keys.map((k) => body[k]));
        const fields = r.fields.map((f) => f.name);
        // scalar functions come back as a single column named after the function
        if (fields.length === 1 && fields[0] === name) return r.rows[0]?.[name] ?? null;
        return r.rows;
      }
      const f = parseFilters(url);
      if (req.method === 'GET') return selectRows(c, name, f);
      if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const outRows = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const r = await c.query(`insert into public.${ident(name)} (${keys.map(ident).join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, keys.map((k) => row[k]));
          outRows.push(r.rows[0]);
        }
        const wantRep = (req.headers.prefer || '').includes('return=representation');
        if (!wantRep) return undefined;
        const cols = f.select === '*' ? null : f.select.split(',');
        return outRows.map((r) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k]])) : r));
      }
      if (req.method === 'DELETE') { await c.query(`delete from public.${ident(name)}${f.where}`, f.vals); return undefined; }
      throw Object.assign(new Error('method not supported'), { status: 405 });
    });
    if (out === undefined) return send(req.method === 'POST' ? 201 : 204);
    if (single) return Array.isArray(out) && out.length === 1 ? send(200, out[0]) : send(406, { code: 'PGRST116', message: 'expected one row' });
    return send(200, out);
  } catch (e) {
    const { status, body: b } = pgErr(e);
    return send(status, b);
  }
});
server.listen(PORT, () => console.log(`fake supabase on :${PORT}\nANON_KEY=${ANON_KEY}`));
