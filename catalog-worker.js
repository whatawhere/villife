const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "X-Villife-Catalog": "1"
};

const statuses = ["draft", "pending review", "approved", "published", "rejected"];

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: Object.assign({}, cors, { "Content-Type": "application/json; charset=utf-8" })
  });
}

function isAdmin(request, env) {
  return !!(env && env.ADMIN_SECRET && request.headers.get("X-Admin-Key") === env.ADMIN_SECRET);
}

function pagination(url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 24));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  return { limit, offset };
}

function phrase(value) {
  return "%" + String(value || "").replace(/[%"_]/g, "") + "%";
}

async function all(env, sql, params) {
  const statement = env.DB.prepare(sql);
  const result = await (params && params.length ? statement.bind(...params) : statement).all();
  return Array.isArray(result && result.results) ? result.results : [];
}

async function one(env, sql, params) {
  const statement = env.DB.prepare(sql);
  const result = await (params && params.length ? statement.bind(...params) : statement).first();
  return result || null;
}

function publishedTrack(sqlAlias) {
  return "EXISTS (SELECT 1 FROM releases r WHERE (r.track_id = " + sqlAlias + ".id OR r.album_id = " + sqlAlias + ".album_id) AND r.status = 'published')";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;
    const page = pagination(url);
    const q = url.searchParams.get("q") || "";

    if (path === "/health") return json({ ready: true, r2: !!(env && env.MEDIA), db: !!(env && env.DB) });

    if (path === "/artists" && request.method === "GET") {
      const rows = await all(env, "SELECT id, name, avatar_url FROM artists WHERE name LIKE ? ORDER BY name LIMIT ? OFFSET ?", [phrase(q), page.limit, page.offset]);
      return json(rows);
    }

    if (path === "/albums" && request.method === "GET") {
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT a.id, a.title, a.artwork_url, a.release_date, ar.name AS artist FROM albums a JOIN artists ar ON ar.id = a.artist_id WHERE (a.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR ar.id = ?) AND EXISTS (SELECT 1 FROM releases r WHERE r.album_id = a.id AND r.status = 'published') ORDER BY a.release_date DESC LIMIT ? OFFSET ?", [phrase(q), phrase(q), artist, artist, page.limit, page.offset]);
      return json(rows);
    }

    if (path === "/tracks" && request.method === "GET") {
      const album = url.searchParams.get("album") || "";
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, al.title AS album FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE (t.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR t.album_id = ?) AND (? = '' OR t.artist_id = ?) AND " + publishedTrack("t") + " ORDER BY t.title LIMIT ? OFFSET ?", [phrase(q), phrase(q), album, album, artist, artist, page.limit, page.offset]);
      return json(rows);
    }

    if (path.startsWith("/tracks/") && request.method === "GET") {
      const id = path.slice("/tracks/".length);
      const row = await one(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, al.title AS album FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.id = ? AND " + publishedTrack("t"), [id]);
      return row ? json(row) : json({ error: "not found" }, 404);
    }

    if (path === "/search" && request.method === "GET") {
      if (!q) return json({ artists: [], albums: [], tracks: [] });
      const artists = await all(env, "SELECT id, name, avatar_url FROM artists WHERE name LIKE ? LIMIT 8", [phrase(q)]);
      const albums = await all(env, "SELECT a.id, a.title, a.artwork_url FROM albums a WHERE a.title LIKE ? AND EXISTS (SELECT 1 FROM releases r WHERE r.album_id = a.id AND r.status = 'published') LIMIT 8", [phrase(q)]);
      const tracks = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url FROM tracks t WHERE t.title LIKE ? AND " + publishedTrack("t") + " LIMIT 16", [phrase(q)]);
      return json({ artists, albums, tracks });
    }

    if (path.startsWith("/lyrics/") && request.method === "GET") {
      const trackId = path.slice("/lyrics/".length);
      const row = await one(env, "SELECT l.language, l.text FROM lyrics l JOIN tracks t ON t.id = l.track_id WHERE l.track_id = ? AND l.status = 'published' AND " + publishedTrack("t"), [trackId]);
      return row ? json(row) : json({ error: "not found" }, 404);
    }

    if (path === "/releases" && request.method === "GET") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const status = url.searchParams.get("status") || "";
      const rows = await all(env, "SELECT id, album_id, track_id, owner_id, status, territory, license_type, updated_at FROM releases WHERE (? = '' OR status = ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?", [status, status, page.limit, page.offset]);
      return json(rows);
    }

    const statusMatch = path.match(/^\/(releases|lyrics)\/([^/]+)\/status$/);
    if (statusMatch && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const table = statusMatch[1];
      const id = statusMatch[2];
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const status = String(body && body.status || "");
      if (!statuses.includes(status)) return json({ error: "invalid status" }, 400);
      const existing = await one(env, "SELECT id FROM " + table + " WHERE id = ?", [id]);
      if (!existing) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE " + table + " SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      await env.DB.prepare("INSERT INTO moderation_actions (id, target_type, target_id, action, actor, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), table, id, status, String(body.actor || "admin"), String(body.reason || "")).run();
      return json({ id, status });
    }

    return json({ error: "not found" }, 404);
  }
};
