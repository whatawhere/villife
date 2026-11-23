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

function sortOrder(url, allowed, fallback) {
  const field = String(url.searchParams.get("sort") || "");
  const direction = String(url.searchParams.get("order") || "").toLowerCase() === "desc" ? "DESC" : "ASC";
  return (allowed.includes(field) ? field : fallback) + " " + direction;
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
      const rows = await all(env, "SELECT id, name, avatar_url FROM artists WHERE name LIKE ? ORDER BY " + sortOrder(url, ["name", "created_at"], "name") + " LIMIT ? OFFSET ?", [phrase(q), page.limit, page.offset]);
      return json(rows);
    }

    if (path === "/albums" && request.method === "GET") {
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT a.id, a.title, a.artwork_url, a.release_date, ar.name AS artist FROM albums a JOIN artists ar ON ar.id = a.artist_id WHERE (a.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR ar.id = ?) AND EXISTS (SELECT 1 FROM releases r WHERE r.album_id = a.id AND r.status = 'published') ORDER BY " + sortOrder(url, ["title", "release_date"], "release_date") + " LIMIT ? OFFSET ?", [phrase(q), phrase(q), artist, artist, page.limit, page.offset]);
      return json(rows);
    }

    if (path === "/tracks" && request.method === "GET") {
      const album = url.searchParams.get("album") || "";
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, al.title AS album FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE (t.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR t.album_id = ?) AND (? = '' OR t.artist_id = ?) AND " + publishedTrack("t") + " ORDER BY " + sortOrder(url, ["title", "duration"], "title") + " LIMIT ? OFFSET ?", [phrase(q), phrase(q), album, album, artist, artist, page.limit, page.offset]);
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
      const rows = await all(env, "SELECT id, album_id, track_id, owner_id, status, reason, territory, license_type, updated_at FROM releases WHERE (? = '' OR status = ?) ORDER BY " + sortOrder(url, ["updated_at", "status"], "updated_at") + " LIMIT ? OFFSET ?", [status, status, page.limit, page.offset]);
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
      const reason = String(body.reason || "");
      if (table === "releases") await env.DB.prepare("UPDATE releases SET status = ?, reason = ?, updated_at = datetime('now') WHERE id = ?").bind(status, reason, id).run();
      else await env.DB.prepare("UPDATE lyrics SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      await env.DB.prepare("INSERT INTO moderation_actions (id, target_type, target_id, action, actor, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), table, id, status, String(body.actor || "admin"), String(body.reason || "")).run();
      return json({ id, status });
    }

    if (path === "/catalog/import" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const items = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : []);
      let imported = 0;
      let skipped = 0;
      const errors = [];
      for (const item of items) {
        const id = String(item && item.id || "").trim();
        const title = String(item && item.title || "").trim();
        const artistId = String(item && item.artistId || "").trim();
        const duration = Math.max(0, Number(item && item.duration) || 0);
        if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id) || !title || !artistId) {
          errors.push({ id: id || null, error: "invalid metadata" });
          continue;
        }
        const existing = await one(env, "SELECT id FROM tracks WHERE id = ?", [id]);
        if (existing) {
          skipped += 1;
          continue;
        }
        await env.DB.prepare("INSERT INTO tracks (id, album_id, artist_id, title, duration, artwork_url) VALUES (?, ?, ?, ?, ?, ?)").bind(id, String(item.albumId || ""), artistId, title, duration, String(item.artworkUrl || "")).run();
        imported += 1;
      }
      return json({ imported, skipped, errors });
    }

    if (path === "/catalog/duplicates" && request.method === "GET") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const rows = await all(env, "SELECT lower(trim(t.title)) AS title_key, ar.name AS artist, COUNT(*) AS copies, GROUP_CONCAT(t.id) AS ids FROM tracks t JOIN artists ar ON ar.id = t.artist_id GROUP BY title_key, ar.name HAVING copies > 1 ORDER BY copies DESC LIMIT 100");
      return json(rows);
    }

    if (path === "/analytics" && request.method === "GET") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const tables = ["artists", "albums", "tracks", "releases", "lyrics", "rights", "users", "playlists", "listening_history", "moderation_actions"];
      const result = {};
      for (const table of tables) {
        const row = await one(env, "SELECT COUNT(*) AS total FROM " + table);
        result[table] = row ? Number(row.total) : 0;
      }
      return json(result);
    }

    if (path === "/reports" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const targetType = String(body && body.targetType || "");
      const targetId = String(body && body.targetId || "");
      const reason = String(body && body.reason || "").slice(0, 2000);
      if (!targetType || !targetId || !reason) return json({ error: "missing fields" }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO moderation_actions (id, target_type, target_id, action, actor, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(id, targetType, targetId, "report", "public", reason).run();
      return json({ id, status: "pending review" });
    }

    if (path.startsWith("/studio/") && request.method === "GET") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      if (path === "/studio/releases") {
        const owner = url.searchParams.get("owner") || "";
        const rows = await all(env, "SELECT id, album_id, track_id, owner_id, status, reason, updated_at FROM releases WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?", [owner, page.limit, page.offset]);
        return json(rows);
      }
      return json({ error: "not found" }, 404);
    }

    if (path === "/studio/upload" && request.method === "POST") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "no file" }, 400);
      const type = String(file.type || "");
      if (!/^(audio\/|application\/octet-stream)/.test(type)) return json({ error: "invalid type" }, 400);
      if (file.size > 52428800) return json({ error: "file too large" }, 400);
      const extension = String(file.name || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
      const key = "audio/" + crypto.randomUUID() + "." + extension;
      await env.MEDIA.put(key, file, { httpMetadata: { contentType: type }, customMetadata: { studio: "1" } });
      return json({ key });
    }

    if (path === "/studio/upload-cover" && request.method === "POST") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "no file" }, 400);
      const type = String(file.type || "");
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "invalid type" }, 400);
      if (file.size > 10485760) return json({ error: "file too large" }, 400);
      const extension = type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1];
      const key = "covers/" + crypto.randomUUID() + "." + extension;
      await env.MEDIA.put(key, file, { httpMetadata: { contentType: type }, customMetadata: { studio: "1" } });
      return json({ key });
    }

    if (path === "/studio/tracks" && request.method === "POST") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const title = String(body && body.title || "").trim();
      const artistId = String(body && body.artistId || "").trim();
      const owner = String(body && body.ownerId || "").trim();
      const duration = Math.max(0, Number(body && body.duration) || 0);
      const audioKey = String(body && body.audioKey || "").trim();
      if (!title || !artistId || !owner || !/^audio\/[a-f0-9-]+\.[a-z0-9]+$/.test(audioKey)) return json({ error: "missing fields" }, 400);
      const artist = await one(env, "SELECT id FROM artists WHERE id = ?", [artistId]);
      if (!artist) return json({ error: "unknown artist" }, 404);
      const id = "tr-" + crypto.randomUUID();
      const releaseId = "rel-" + crypto.randomUUID();
      await env.DB.prepare("INSERT INTO tracks (id, artist_id, title, duration, audio_key, artwork_url) VALUES (?, ?, ?, ?, ?, ?)").bind(id, artistId, title, duration, audioKey, String(body.artworkUrl || "")).run();
      await env.DB.prepare("INSERT INTO releases (id, track_id, owner_id, status, territory, license_type) VALUES (?, ?, ?, 'draft', ?, ?)").bind(releaseId, id, owner, String(body.territory || ""), String(body.licenseType || "")).run();
      return json({ id, releaseId, status: "draft" });
    }

    const trackMatch = path.match(/^\/studio\/tracks\/([^/]+)$/);
    if (trackMatch && request.method === "GET") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      const row = await one(env, "SELECT t.id, t.title, t.duration, t.artwork_url, r.status, r.reason FROM tracks t JOIN releases r ON r.track_id = t.id WHERE t.id = ?", [trackMatch[1]]);
      return row ? json(row) : json({ error: "not found" }, 404);
    }

    const editMatch = path.match(/^\/studio\/tracks\/([^/]+)$/);
    if (editMatch && request.method === "PATCH") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const id = editMatch[1];
      const release = await one(env, "SELECT status FROM releases WHERE track_id = ?", [id]);
      if (!release) return json({ error: "not found" }, 404);
      if (release.status !== "draft" && release.status !== "rejected") return json({ error: "not editable" }, 409);
      const title = String(body && body.title || "").trim();
      const duration = Math.max(0, Number(body && body.duration) || 0);
      const artworkUrl = String(body && body.artworkUrl || "").trim();
      await env.DB.prepare("UPDATE tracks SET title = ?, duration = ?, artwork_url = ? WHERE id = ?").bind(title, duration, artworkUrl, id).run();
      if (release.status === "rejected") await env.DB.prepare("UPDATE releases SET status = 'draft', updated_at = datetime('now') WHERE track_id = ?").bind(id).run();
      return json({ id, title, duration, artworkUrl });
    }

    const submitMatch = path.match(/^\/studio\/releases\/([^/]+)\/submit$/);
    if (submitMatch && request.method === "POST") {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      const release = await one(env, "SELECT id, status FROM releases WHERE id = ?", [submitMatch[1]]);
      if (!release) return json({ error: "not found" }, 404);
      if (release.status !== "draft" && release.status !== "rejected") return json({ error: "invalid status" }, 400);
      await env.DB.prepare("UPDATE releases SET status = 'pending review', updated_at = datetime('now') WHERE id = ?").bind(release.id).run();
      return json({ id: release.id, status: "pending review" });
    }

    return json({ error: "not found" }, 404);
  }
};
