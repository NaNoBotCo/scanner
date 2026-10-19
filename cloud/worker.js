// Scanner's drop. The linked phone puts a scan here; the Mac takes it into the
// folder she picked, then removes it from here. Every route needs X-Key.
//   PUT    /f/<id>      one file    X-Name X-Dest X-Group X-Side X-Event (URI-encoded)
//   GET    /list        files waiting, for the Mac
//   GET    /get/<id>    one file, for the Mac
//   DELETE /f/<id>      the Mac has it
//   GET    /dests       the folders the Mac offers
//   PUT    /dests       the Mac's list of folders
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'X-Key,X-Name,X-Dest,X-Group,X-Side,X-Event,Content-Type',
};
const ID = /^[0-9a-z-]{6,60}$/, DESTS = '_dests.json';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!same(req.headers.get('X-Key'), env.KEY)) return json({ error: 'this phone is not linked' }, 401);
    const p = new URL(req.url).pathname.split('/').filter(Boolean);
    const h = k => (req.headers.get(k) || '').slice(0, 300);

    if (p[0] === 'f' && ID.test(p[1] || '') && req.method === 'PUT') {
      const body = await req.arrayBuffer();
      if (!body.byteLength) return json({ error: 'empty' }, 400);
      await env.DROP.put('f/' + p[1], body, {
        httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' },
        customMetadata: { name: h('X-Name'), dest: h('X-Dest'), group: h('X-Group'), side: h('X-Side'), event: h('X-Event') },
      });
      return json({ ok: true, bytes: body.byteLength });
    }

    if (p[0] === 'f' && ID.test(p[1] || '') && req.method === 'DELETE') {
      await env.DROP.delete('f/' + p[1]);
      return json({ ok: true });
    }

    if (p[0] === 'list' && req.method === 'GET') {
      const out = []; let cursor;
      do {
        const r = await env.DROP.list({ prefix: 'f/', cursor, include: ['customMetadata', 'httpMetadata'] });
        for (const o of r.objects) out.push({ id: o.key.slice(2), size: o.size, uploaded: o.uploaded, type: o.httpMetadata?.contentType || '', ...o.customMetadata });
        cursor = r.truncated ? r.cursor : null;
      } while (cursor);
      return json(out);
    }

    if (p[0] === 'get' && ID.test(p[1] || '') && req.method === 'GET') {
      const o = await env.DROP.get('f/' + p[1]);
      if (!o) return json({ error: 'not found' }, 404);
      return new Response(o.body, { headers: { ...CORS, 'Content-Type': o.httpMetadata?.contentType || 'application/octet-stream' } });
    }

    if (p[0] === 'dests' && req.method === 'GET') {
      const o = await env.DROP.get(DESTS);
      return o ? new Response(o.body, { headers: { ...CORS, 'Content-Type': 'application/json' } }) : json([]);
    }

    if (p[0] === 'dests' && req.method === 'PUT') {
      const body = await req.text();
      try { JSON.parse(body); } catch { return json({ error: 'not json' }, 400); }
      await env.DROP.put(DESTS, body, { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }

    return json({ error: 'no such route' }, 404);
  },
};
