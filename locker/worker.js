// Blasta Bank Locker — a password-protected store for your own SoundFont / OP2 banks.
// Cloudflare Worker + private R2 bucket. Every request must carry the locker password
// (Authorization: Bearer …), which lives only as the LOCKER_PASSWORD secret.
//
//   GET    /banks            list banks
//   PUT    /banks/:name      upload (raw body)
//   GET    /banks/:name      download
//   DELETE /banks/:name      delete
//   GET    /config           which bank is in which Blasta slot (owner's devices)
//   PUT    /config           save slot assignments (JSON)
//   PUT    /public           owner: { banks: [names], slots: { fm, sf2, sf3 } } — what visitors get
//
// Public, read-only (no password):
//   GET    /public                 public banks + the site's default slots
//   GET    /public/banks/:name     download a bank the owner marked public

const CONFIG_KEY = '_config.json';
const PUBLIC_KEY = '_public.json';
const SLOTS = ['fm', 'sf2', 'sf3'];
const MAX_NAME = 120;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'ETag',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...cors, ...extra } });
    const json = (obj, status = 200) => reply(JSON.stringify(obj), status, { 'Content-Type': 'application/json' });

    if (req.method === 'OPTIONS') return reply(null, 204);
    if (origin && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403);
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    // ---- public, read-only ----
    if (req.method === 'GET' && (path === '/public' || path.startsWith('/public/banks/'))) {
      const pub = await readPublic(env);
      if (path === '/public') {
        const banks = [];
        for (const name of pub.banks) {
          const h = await env.BANKS.head(name);
          if (h) banks.push({ name, size: h.size, etag: h.httpEtag, kind: kindOf(name) });
        }
        const live = Object.fromEntries(banks.map(b => [b.name, b]));
        const slots = {};
        for (const k of SLOTS) {
          const s = pub.slots[k];
          if (s && live[s.name]) slots[k] = { name: s.name, etag: live[s.name].etag, budget: s.budget };
        }
        return json({ banks, slots }, 200);
      }
      const name = path.slice('/public/banks/'.length);
      if (!pub.banks.includes(name)) return json({ error: 'not found' }, 404);
      const o = await env.BANKS.get(name);
      if (!o) return json({ error: 'not found' }, 404);
      return reply(o.body, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size), ETag: o.httpEtag, 'Cache-Control': 'public, max-age=300' });
    }

    // ---- everything else needs the password ----
    if (!env.LOCKER_PASSWORD) return json({ error: 'locker password not configured' }, 500);
    if (!(await authorized(req, env.LOCKER_PASSWORD))) {
      await new Promise(r => setTimeout(r, 400));          // slow down guessing
      return json({ error: 'wrong password' }, 401);
    }

    if (path === '/public' && req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await req.text()); } catch { return json({ error: 'bad json' }, 400); }
      const banks = [...new Set((body.banks || []).filter(n => typeof n === 'string' && validName(n)))].slice(0, 500);
      const slots = {};
      for (const k of SLOTS) {
        const s = body.slots && body.slots[k];
        if (s && typeof s.name === 'string' && banks.includes(s.name)) slots[k] = { name: s.name, budget: s.budget === 'raw' ? 'raw' : (k === 'sf2' ? 'awe' : k === 'sf3' ? 'live' : undefined) };
      }
      await env.BANKS.put(PUBLIC_KEY, JSON.stringify({ banks, slots }), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, banks, slots });
    }

    if (path === '/banks' && req.method === 'GET') {
      const out = [];
      let cursor;
      do {
        const page = await env.BANKS.list({ cursor, include: ['customMetadata'] });
        for (const o of page.objects) if (!o.key.startsWith('_')) out.push({ name: o.key, size: o.size, etag: o.httpEtag, uploaded: o.uploaded, kind: kindOf(o.key) });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => a.name.localeCompare(b.name));
      return json(out);
    }

    if (path === '/config') {
      if (req.method === 'GET') {
        const o = await env.BANKS.get(CONFIG_KEY);
        return json(o ? await o.json() : {});
      }
      if (req.method === 'PUT') {
        const text = await req.text();
        if (text.length > 10000) return json({ error: 'config too large' }, 413);
        try { JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
        await env.BANKS.put(CONFIG_KEY, text, { httpMetadata: { contentType: 'application/json' } });
        return json({ ok: true });
      }
    }

    const m = path.match(/^\/banks\/(.+)$/);
    if (m) {
      const name = m[1];
      if (!validName(name)) return json({ error: 'bad name (use .sf2 or .op2, no slashes)' }, 400);
      if (req.method === 'GET') {
        const o = await env.BANKS.get(name);
        if (!o) return json({ error: 'not found' }, 404);
        return reply(o.body, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size), ETag: o.httpEtag, 'Cache-Control': 'private, no-store' });
      }
      if (req.method === 'PUT') {
        if (!req.body) return json({ error: 'empty upload' }, 400);
        const o = await env.BANKS.put(name, req.body, { httpMetadata: { contentType: 'application/octet-stream' } });
        return json({ ok: true, name, size: o.size, etag: o.httpEtag });
      }
      if (req.method === 'DELETE') {
        await env.BANKS.delete(name);
        const pub = await readPublic(env);           // a deleted bank stops being public
        if (pub.banks.includes(name)) {
          pub.banks = pub.banks.filter(n => n !== name);
          for (const k of SLOTS) if (pub.slots[k] && pub.slots[k].name === name) delete pub.slots[k];
          await env.BANKS.put(PUBLIC_KEY, JSON.stringify(pub), { httpMetadata: { contentType: 'application/json' } });
        }
        return json({ ok: true });
      }
    }
    return json({ error: 'not found' }, 404);
  },
};

async function authorized(req, secret) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return false;
  const enc = new TextEncoder();
  // hash both sides so the comparison is constant-time and length-independent
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(h.slice(7))), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function readPublic(env) {
  const o = await env.BANKS.get(PUBLIC_KEY);
  const p = o ? await o.json().catch(() => ({})) : {};
  return { banks: Array.isArray(p.banks) ? p.banks : [], slots: p.slots || {} };
}
function validName(n) {
  return n.length <= MAX_NAME && !n.startsWith('_') && !/[\/\\\x00-\x1f]/.test(n) && !n.startsWith('.') && /\.(sf2|op2)$/i.test(n);
}
function kindOf(n) { return /\.op2$/i.test(n) ? 'op2' : 'sf2'; }
