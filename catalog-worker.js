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

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(length) {
  return toHex(crypto.getRandomValues(new Uint8Array(length)));
}

async function hashValue(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return toHex(digest);
}

async function smtpSend(env, to, subject, text) {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect("smtp.gmail.com:465", { secureTransport: "on" });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readResponse = async () => {
    let buffer = "";
    while (true) {
      if (buffer.endsWith("\r\n")) {
        const lines = buffer.trimEnd().split("\r\n");
        if (/^\d{3} /.test(lines[lines.length - 1])) return buffer;
      }
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
    }
    return buffer;
  };
  const command = async line => {
    await writer.write(encoder.encode(line + "\r\n"));
    const reply = await readResponse();
    const status = reply.slice(0, 3);
    if (!/^\d{3} /.test(status)) console.error("smtp unexpected reply", line.split(" ")[0], reply.slice(0, 200));
    return reply;
  };
  try {
    let reply = await readResponse();
    if (!reply.startsWith("220")) return false;
    reply = await command("EHLO villife.hs.vc");
    if (!reply.includes("250")) return false;
    const auth = btoa("\0" + env.MAIL_USER + "\0" + env.MAIL_PASS);
    reply = await command("AUTH PLAIN " + auth);
    if (!reply.startsWith("235")) return false;
    reply = await command("MAIL FROM:<" + env.MAIL_USER + ">");
    if (!reply.startsWith("250")) return false;
    reply = await command("RCPT TO:<" + to + ">");
    if (!reply.startsWith("250") && !reply.startsWith("251")) return false;
    reply = await command("DATA");
    if (!reply.startsWith("354")) return false;
    const message = [
      "From: Villife <" + env.MAIL_USER + ">",
      "Reply-To: villife@villife.hs.vc",
      "To: " + to,
      "Subject: " + subject,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      text,
      "."
    ].join("\r\n") + "\r\n";
    await writer.write(encoder.encode(message));
    reply = await readResponse();
    if (!reply.startsWith("250")) return false;
    await command("QUIT");
    return true;
  } finally {
    writer.releaseLock();
    reader.releaseLock();
    socket.close();
  }
}

async function sendEmailCode(env, to, code) {
  const subject = "Villife login code";
  const text = "Your Villife login code is " + code + ". It expires in 10 minutes.";
  if (env.MAIL_USER && env.MAIL_PASS) return smtpSend(env, to, subject, text);
  if (!env.EMAIL_API_URL || !env.EMAIL_API_KEY) return false;
  const response = await fetch(env.EMAIL_API_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.EMAIL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "Villife <no-reply@villife.hs.vc>",
      to: [to],
      subject: "Villife login code",
      text: "Your Villife login code is " + code + ". It expires in 10 minutes.",
      html: "<p>Your Villife login code is <b>" + code + "</b>. It expires in 10 minutes.</p>"
    })
  });
  return response.ok;
}

function base64url(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derivePassword(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, material, 256);
  return toHex(bits);
}

async function authKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeToken(payload, secret) {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64url(await crypto.subtle.sign("HMAC", await authKey(secret), new TextEncoder().encode(body)));
  return body + "." + signature;
}

async function readToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const valid = await crypto.subtle.verify("HMAC", await authKey(secret), unbase64url(parts[1]), new TextEncoder().encode(parts[0]));
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unbase64url(parts[0])));
    if (!payload || !payload.sub || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (error) {
    return null;
  }
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

    if (path === "/auth/register" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const password = String(body && body.password || "");
      const displayName = String(body && body.displayName || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) return json({ error: "invalid credentials" }, 400);
      const existing = await one(env, "SELECT id FROM users WHERE email = ?", [email]);
      if (existing) return json({ error: "email already registered" }, 409);
      const id = "usr-" + crypto.randomUUID();
      const salt = randomHex(16);
      const hash = await derivePassword(password, salt);
      await env.DB.prepare("INSERT INTO users (id, email, display_name, password_hash, salt) VALUES (?, ?, ?, ?, ?)").bind(id, email, displayName, hash, salt).run();
      const token = await makeToken({ sub: id, email, exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      return json({ id, email, displayName, token });
    }

    if (path === "/auth/login" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const password = String(body && body.password || "");
      const user = await one(env, "SELECT id, email, display_name, password_hash, salt, role, token_version FROM users WHERE email = ?", [email]);
      if (!user || !user.password_hash || !user.salt) return json({ error: "invalid credentials" }, 401);
      const hash = await derivePassword(password, String(user.salt));
      if (hash !== String(user.password_hash)) return json({ error: "invalid credentials" }, 401);
      const token = await makeToken({ sub: user.id, email: user.email, ver: Number(user.token_version), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      return json({ id: user.id, email: user.email, displayName: user.display_name, role: user.role, token });
    }

    if (path === "/auth/me" && request.method === "GET") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      const header = request.headers.get("Authorization") || "";
      const payload = await readToken(header.replace(/^Bearer\s+/i, ""), env.AUTH_SECRET);
      if (!payload) return json({ error: "unauthorized" }, 401);
      const user = await one(env, "SELECT id, email, display_name, role, token_version FROM users WHERE id = ?", [payload.sub]);
      if (!user || Number(user.token_version) !== Number(payload.ver || 0)) return json({ error: "unauthorized" }, 401);
      return json({ id: user.id, email: user.email, displayName: user.display_name, role: user.role });
    }

    if (path === "/auth/email/request" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid email" }, 400);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const hash = await hashValue(code);
      const expires = Date.now() + 600000;
      await env.DB.prepare("INSERT INTO email_codes (email, hash, expires) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires").bind(email, hash, expires).run();
      const sent = await sendEmailCode(env, email, code);
      if (!sent && env.EMAIL_DEBUG !== "1") return json({ error: "email delivery unavailable" }, 503);
      const result = { sent };
      if (!sent && env.EMAIL_DEBUG === "1") result.devCode = code;
      return json(result);
    }

    if (path === "/auth/email/verify" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const code = String(body && body.code || "").trim();
      const record = await one(env, "SELECT hash, expires FROM email_codes WHERE email = ?", [email]);
      if (!record || Number(record.expires) < Date.now()) return json({ error: "code expired" }, 410);
      if (await hashValue(code) !== String(record.hash)) return json({ error: "invalid code" }, 401);
      await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
      let user = await one(env, "SELECT id, email, display_name, role, token_version FROM users WHERE email = ?", [email]);
      if (!user) {
        const id = "usr-" + crypto.randomUUID();
        const displayName = email.split("@")[0];
        await env.DB.prepare("INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)").bind(id, email, displayName).run();
        user = { id, email, display_name: displayName, role: "user", token_version: 0 };
      }
      const token = await makeToken({ sub: user.id, email: user.email, ver: Number(user.token_version), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      return json({ id: user.id, email: user.email, displayName: user.display_name, role: user.role, token });
    }

    if (path === "/auth/qr/create" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        body = {};
      }
      const device = String(body && body.device || "Unknown device").slice(0, 120);
      const id = randomHex(16);
      const now = Date.now();
      await env.DB.prepare("INSERT INTO qr_sessions (id, device, status, created_at, expires) VALUES (?, ?, 'pending', ?, ?)").bind(id, device, now, now + 300000).run();
      return json({ session: id, device, expires: now + 300000 });
    }

    if (path === "/auth/qr/status" && request.method === "GET") {
      const session = url.searchParams.get("session") || "";
      const row = await one(env, "SELECT status, token, device, expires FROM qr_sessions WHERE id = ?", [session]);
      if (!row) return json({ error: "not found" }, 404);
      if (Number(row.expires) < Date.now()) return json({ status: "expired" });
      const result = { status: row.status, device: row.device };
      if (row.status === "approved" && row.token) result.token = row.token;
      return json(result);
    }

    if (path === "/auth/qr/approve" && request.method === "POST") {
      if (!env.AUTH_SECRET) return json({ error: "auth unavailable" }, 503);
      const header = request.headers.get("Authorization") || "";
      const payload = await readToken(header.replace(/^Bearer\s+/i, ""), env.AUTH_SECRET);
      if (!payload) return json({ error: "unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const session = String(body && body.session || "");
      const decision = String(body && body.decision || "");
      if (decision !== "approve" && decision !== "deny") return json({ error: "invalid decision" }, 400);
      const row = await one(env, "SELECT expires, status FROM qr_sessions WHERE id = ?", [session]);
      if (!row) return json({ error: "not found" }, 404);
      if (Number(row.expires) < Date.now() || row.status !== "pending") return json({ error: "session unavailable" }, 409);
      if (decision === "deny") {
        await env.DB.prepare("UPDATE qr_sessions SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(session).run();
        return json({ status: "denied" });
      }
      const token = await makeToken({ sub: payload.sub, email: payload.email, ver: Number(payload.ver || 0), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      await env.DB.prepare("UPDATE qr_sessions SET status = 'approved', token = ? WHERE id = ? AND status = 'pending'").bind(token, session).run();
      return json({ status: "approved" });
    }

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

    if (path === "/recommendations" && request.method === "GET") {
      const user = url.searchParams.get("user") || "";
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 12));
      if (!user) return json([]);
      const rows = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, COUNT(h.id) AS score FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN listening_history h ON h.user_id = ? AND h.track_id IN (SELECT id FROM tracks WHERE artist_id = t.artist_id) WHERE t.artist_id IN (SELECT t2.artist_id FROM tracks t2 JOIN listening_history h2 ON h2.track_id = t2.id WHERE h2.user_id = ?) AND t.id NOT IN (SELECT track_id FROM listening_history WHERE user_id = ?) AND " + publishedTrack("t") + " GROUP BY t.id ORDER BY score DESC, t.title LIMIT ?", [user, user, user, limit]);
      return json(rows);
    }

    const followMatch = path.match(/^\/users\/([^/]+)\/follow$/);
    if (followMatch && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return json({ error: "invalid json" }, 400);
      }
      const follower = String(body && body.followerId || "").trim();
      const artist = followMatch[1];
      if (!follower || !artist) return json({ error: "missing fields" }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, artist_id) VALUES (?, ?)").bind(follower, artist).run();
      return json({ followerId: follower, artistId: artist, following: true });
    }
    if (followMatch && request.method === "DELETE") {
      const follower = url.searchParams.get("follower") || "";
      if (!follower) return json({ error: "missing follower" }, 400);
      await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND artist_id = ?").bind(follower, followMatch[1]).run();
      return json({ following: false });
    }

    const followingMatch = path.match(/^\/users\/([^/]+)\/following$/);
    if (followingMatch && request.method === "GET") {
      const rows = await all(env, "SELECT artist_id, created_at FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT ?", [followingMatch[1], page.limit]);
      return json(rows);
    }

    const artistAnalytics = path.match(/^\/analytics\/artist\/([^/]+)$/);
    if (artistAnalytics && request.method === "GET") {
      const id = artistAnalytics[1];
      const plays = await one(env, "SELECT COUNT(*) AS total FROM listening_history h JOIN tracks t ON t.id = h.track_id WHERE t.artist_id = ?", [id]);
      const listeners = await one(env, "SELECT COUNT(DISTINCT h.user_id) AS total FROM listening_history h JOIN tracks t ON t.id = h.track_id WHERE t.artist_id = ?", [id]);
      const tracks = await one(env, "SELECT COUNT(*) AS total FROM tracks WHERE artist_id = ?", [id]);
      return json({ artistId: id, plays: plays ? Number(plays.total) : 0, listeners: listeners ? Number(listeners.total) : 0, tracks: tracks ? Number(tracks.total) : 0 });
    }

    const offlineMatch = path.match(/^\/offline\/eligible\/([^/]+)$/);
    if (offlineMatch && request.method === "GET") {
      const row = await one(env, "SELECT r.offline_allowed, r.status, r.valid_until FROM releases r WHERE r.track_id = ? ORDER BY r.updated_at DESC LIMIT 1", [offlineMatch[1]]);
      const allowed = !!row && row.status === "published" && Number(row.offline_allowed) === 1 && (!row.valid_until || row.valid_until > new Date().toISOString().slice(0, 10));
      return json({ trackId: offlineMatch[1], allowed });
    }

    const syncMatch = path.match(/^\/sync\/([^/]+)$/);
    if (syncMatch) {
      if (!env.STUDIO_SECRET || request.headers.get("X-Studio-Key") !== env.STUDIO_SECRET) return json({ error: "forbidden" }, 403);
      const owner = syncMatch[1];
      if (request.method === "GET") {
        const row = await one(env, "SELECT data, updated_at FROM sync_state WHERE owner_id = ?", [owner]);
        return row ? json({ data: JSON.parse(row.data), updatedAt: row.updated_at }) : json({ data: null });
      }
      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return json({ error: "invalid json" }, 400);
        }
        const data = JSON.stringify(body && body.data !== undefined ? body.data : body);
        if (data.length > 1048576) return json({ error: "too large" }, 400);
        await env.DB.prepare("INSERT INTO sync_state (owner_id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')").bind(owner, data).run();
        return json({ ownerId: owner, updated: true });
      }
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
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      await env.MEDIA.put(key, file, { httpMetadata: { contentType: type }, customMetadata: { studio: "1", sha256: sha256 } });
      return json({ key, sha256 });
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
