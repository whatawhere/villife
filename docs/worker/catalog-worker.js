const cors = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key, X-Studio-Key, X-CSRF-Token",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Credentials": "true",
  "X-Villife-Catalog": "1"
};

const allowedOrigins = ["https://villife.hs.vc", "https://web.villife.hs.vc", "http://localhost:5173", "http://127.0.0.1:8080"];
const statuses = ["draft", "pending review", "approved", "published", "rejected"];

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function allowedOrigin(request) {
  const origin = request && request.headers ? request.headers.get("Origin") : null;
  return origin && allowedOrigins.includes(origin) ? origin : null;
}

function responseHeaders(request) {
  const result = Object.assign({}, cors, securityHeaders());
  const origin = allowedOrigin(request);
  if (origin) {
    result["Access-Control-Allow-Origin"] = origin;
    result["Vary"] = "Origin";
  }
  return result;
}

function json(value, status, request) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: Object.assign(responseHeaders(request), { "Content-Type": "application/json; charset=utf-8" })
  });
}

async function rateLimit(request, env, scope, limit) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const key = scope + ":" + ip;
  const now = Date.now();
  const row = await one(env, "SELECT count, start FROM rate_limits WHERE key = ?", [key]);
  if (!row || now - Number(row.start) > 60000) {
    await env.DB.prepare("INSERT INTO rate_limits (key, count, start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, start = excluded.start").bind(key, now).run();
    return false;
  }
  const count = Number(row.count) + 1;
  await env.DB.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").bind(count, key).run();
  return count > limit;
}

function cookieToken(request, name) {
  const value = request.headers.get("Cookie") || "";
  for (const part of value.split(";")) {
    const pair = part.trim().split("=");
    if (pair[0] === name) return decodeURIComponent(pair.slice(1).join("="));
  }
  return null;
}

function sessionOptions(maxAge) {
  return "Path=/; Max-Age=" + maxAge + "; Secure; HttpOnly; SameSite=None";
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of String(value || "").toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return new Uint8Array(bytes);
}

async function totpCode(secret, counter) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = signature[signature.length - 1] & 0x0f;
  const value = ((signature[offset] & 0x7f) << 24 | signature[offset + 1] << 16 | signature[offset + 2] << 8 | signature[offset + 3]) % 1000000;
  return String(value).padStart(6, "0");
}

async function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let delta = -1; delta <= 1; delta++) {
    if (await totpCode(secret, step + delta) === String(code).trim()) return true;
  }
  return false;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_SECRET || request.headers.get("X-Admin-Key") !== env.ADMIN_SECRET) return false;
  if (env.ADMIN_TOTP) {
    const code = request.headers.get("X-Admin-Code") || "";
    if (!(await verifyTotp(env.ADMIN_TOTP, code))) return false;
  }
  return true;
}

async function currentUser(request, env) {
  if (!env.AUTH_SECRET) return null;
  const header = request.headers.get("Authorization") || "";
  const token = header ? header.replace(/^Bearer\s+/i, "") : cookieToken(request, "villife_session");
  const payload = await readToken(token, env.AUTH_SECRET);
  if (!payload) return null;
  const user = await one(env, "SELECT id, email, display_name, role, token_version FROM users WHERE id = ?", [payload.sub]);
  if (!user || Number(user.token_version) !== Number(payload.ver || 0)) return null;
  return user;
}

async function hasStudioAccess(request, env) {
  if (env.STUDIO_SECRET && request.headers.get("X-Studio-Key") === env.STUDIO_SECRET) return true;
  return !!(await currentUser(request, env));
}

function pagination(url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 24));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  return { limit, offset };
}

function phrase(value) {
  return "%" + String(value || "").replace(/[%"_]/g, "") + "%";
}

function sortOrder(url, allowed, fallback, prefix) {
  const field = String(url.searchParams.get("sort") || "");
  const direction = String(url.searchParams.get("order") || "").toLowerCase() === "desc" ? "DESC" : "ASC";
  const chosen = allowed.includes(field) ? field : fallback;
  return (prefix ? prefix + "." + chosen : chosen) + " " + direction;
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

function sniffType(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return "audio/flac";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "audio/mp4";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return "audio/wav";
  return null;
}

const typeExtensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/wav": "wav"
};

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
      "Reply-To: " + env.MAIL_USER,
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

async function loadArgon2() {
  try {
    const module = await import("@noble/hashes/argon2");
    return module.argon2id;
  } catch (error) {
    return null;
  }
}

async function pbkdf2(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, material, 256);
  return toHex(bits);
}

async function derivePassword(password, salt) {
  const argon2id = await loadArgon2();
  if (!argon2id) return "pbkdf2$" + await pbkdf2(password, salt);
  const bytes = argon2id(new TextEncoder().encode(password), new TextEncoder().encode(salt), { t: 3, m: 19456, p: 4, dkLen: 32 });
  return "argon2id$" + toHex(bytes);
}

async function verifyPassword(password, salt, stored) {
  const value = String(stored || "");
  if (value.startsWith("argon2id$")) {
    const argon2id = await loadArgon2();
    if (!argon2id) return false;
    const bytes = argon2id(new TextEncoder().encode(password), new TextEncoder().encode(salt), { t: 3, m: 19456, p: 4, dkLen: 32 });
    return "argon2id$" + toHex(bytes) === value;
  }
  if (value.startsWith("pbkdf2$")) return "pbkdf2$" + await pbkdf2(password, salt) === value;
  return await pbkdf2(password, salt) === value;
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
    const reply = (value, status) => json(value, status, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders(request) });
    const url = new URL(request.url);
    const path = url.pathname;
    const page = pagination(url);
    const q = url.searchParams.get("q") || "";

    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    const browserRequest = !!(request.headers.get("Origin") || cookieToken(request, "villife_session"));
    const hasApiKey = !!(request.headers.get("X-Admin-Key") || request.headers.get("X-Studio-Key") || /^Bearer\s+/i.test(request.headers.get("Authorization") || ""));
    if (mutating && browserRequest && !hasApiKey && path !== "/auth/csrf") {
      const csrfToken = request.headers.get("X-CSRF-Token");
      const csrfCookie = cookieToken(request, "villife_csrf");
      if (!csrfToken || !csrfCookie || csrfToken !== csrfCookie) return reply({ error: "invalid csrf token" }, 403);
    }
    if (await rateLimit(request, env, path, path.startsWith("/auth/") ? 30 : 60)) return reply({ error: "too many requests" }, 429);

    if (path === "/auth/csrf" && request.method === "GET") {
      const token = randomHex(24);
      const response = reply({ token });
      response.headers.set("Set-Cookie", "villife_csrf=" + token + "; Path=/; Max-Age=86400; Secure; SameSite=None");
      return response;
    }

    if (path === "/auth/logout" && request.method === "POST") {
      const response = reply({ signedOut: true });
      response.headers.set("Set-Cookie", "villife_session=; " + sessionOptions(0));
      return response;
    }

    if (path === "/health") return reply({ ready: true, r2: !!(env && env.MEDIA), db: !!(env && env.DB) });

    if (path === "/auth/register" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const password = String(body && body.password || "");
      const displayName = String(body && body.displayName || "").trim().slice(0, 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) return reply({ error: "invalid credentials" }, 400);
      const existing = await one(env, "SELECT id FROM users WHERE email = ?", [email]);
      if (existing) return reply({ error: "email already registered" }, 409);
      const id = "usr-" + crypto.randomUUID();
      const salt = randomHex(16);
      const hash = await derivePassword(password, salt);
      await env.DB.prepare("INSERT INTO users (id, email, display_name, password_hash, salt) VALUES (?, ?, ?, ?, ?)").bind(id, email, displayName, hash, salt).run();
      const token = await makeToken({ sub: id, email, exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      const response = reply({ id, email, displayName, token });
      response.headers.set("Set-Cookie", "villife_session=" + encodeURIComponent(token) + "; " + sessionOptions(2592000));
      return response;
    }

    if (path === "/auth/login" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const password = String(body && body.password || "");
      const identity = String(body && body.email || "").trim();
      const user = await one(env, "SELECT id, email, display_name, password_hash, salt, role, token_version FROM users WHERE email = ? OR lower(display_name) = lower(?) OR id = ? ORDER BY CASE WHEN email = ? THEN 0 ELSE 1 END LIMIT 1", [identity, identity, identity, identity]);
      if (!user || !user.password_hash || !user.salt) return reply({ error: "invalid credentials" }, 401);
      if (!(await verifyPassword(password, String(user.salt), String(user.password_hash)))) return reply({ error: "invalid credentials" }, 401);
      const token = await makeToken({ sub: user.id, email: user.email, ver: Number(user.token_version), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      const response = reply({ id: user.id, email: user.email, displayName: user.display_name, role: user.role, token });
      response.headers.set("Set-Cookie", "villife_session=" + encodeURIComponent(token) + "; " + sessionOptions(2592000));
      return response;
    }

    if (path === "/auth/me" && request.method === "GET") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      const header = request.headers.get("Authorization") || "";
      const token = header ? header.replace(/^Bearer\s+/i, "") : cookieToken(request, "villife_session");
      const payload = await readToken(token, env.AUTH_SECRET);
      if (!payload) return reply({ error: "unauthorized" }, 401);
      const user = await one(env, "SELECT id, email, display_name, role, token_version FROM users WHERE id = ?", [payload.sub]);
      if (!user || Number(user.token_version) !== Number(payload.ver || 0)) return reply({ error: "unauthorized" }, 401);
      return reply({ id: user.id, email: user.email, displayName: user.display_name, role: user.role });
    }

    if (path === "/auth/email/request" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ error: "invalid email" }, 400);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const hash = await hashValue(code);
      const expires = Date.now() + 600000;
      await env.DB.prepare("INSERT INTO email_codes (email, hash, expires) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires").bind(email, hash, expires).run();
      const sent = await sendEmailCode(env, email, code);
      if (!sent) return reply({ error: "email delivery unavailable" }, 503);
      return reply({ sent: true });
    }

    if (path === "/auth/email/verify" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const email = String(body && body.email || "").trim().toLowerCase();
      const code = String(body && body.code || "").trim();
      const record = await one(env, "SELECT hash, expires FROM email_codes WHERE email = ?", [email]);
      if (!record || Number(record.expires) < Date.now()) return reply({ error: "code expired" }, 410);
      if (await hashValue(code) !== String(record.hash)) return reply({ error: "invalid code" }, 401);
      await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
      let user = await one(env, "SELECT id, email, display_name, role, token_version FROM users WHERE email = ?", [email]);
      if (!user) {
        const id = "usr-" + crypto.randomUUID();
        const displayName = email.split("@")[0];
        await env.DB.prepare("INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)").bind(id, email, displayName).run();
        user = { id, email, display_name: displayName, role: "user", token_version: 0 };
      }
      const token = await makeToken({ sub: user.id, email: user.email, ver: Number(user.token_version), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      const response = reply({ id: user.id, email: user.email, displayName: user.display_name, role: user.role, token });
      response.headers.set("Set-Cookie", "villife_session=" + encodeURIComponent(token) + "; " + sessionOptions(2592000));
      return response;
    }

    if (path === "/auth/qr/create" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
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
      return reply({ session: id, device, expires: now + 300000 });
    }

    if (path === "/auth/qr/status" && request.method === "GET") {
      const session = url.searchParams.get("session") || "";
      const row = await one(env, "SELECT status, token, device, expires FROM qr_sessions WHERE id = ?", [session]);
      if (!row) return reply({ error: "not found" }, 404);
      if (Number(row.expires) < Date.now()) return reply({ status: "expired" });
      const result = { status: row.status, device: row.device };
      const response = reply(result);
      if (row.status === "approved" && row.token) {
        response.headers.set("Set-Cookie", "villife_session=" + encodeURIComponent(row.token) + "; " + sessionOptions(2592000));
      }
      return response;
    }

    if (path === "/auth/qr/approve" && request.method === "POST") {
      if (!env.AUTH_SECRET) return reply({ error: "auth unavailable" }, 503);
      const header = request.headers.get("Authorization") || "";
      const token = header ? header.replace(/^Bearer\s+/i, "") : cookieToken(request, "villife_session");
      const payload = await readToken(token, env.AUTH_SECRET);
      if (!payload) return reply({ error: "unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const session = String(body && body.session || "");
      const decision = String(body && body.decision || "");
      if (decision !== "approve" && decision !== "deny") return reply({ error: "invalid decision" }, 400);
      const row = await one(env, "SELECT expires, status FROM qr_sessions WHERE id = ?", [session]);
      if (!row) return reply({ error: "not found" }, 404);
      if (Number(row.expires) < Date.now() || row.status !== "pending") return reply({ error: "session unavailable" }, 409);
      if (decision === "deny") {
        await env.DB.prepare("UPDATE qr_sessions SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(session).run();
        return reply({ status: "denied" });
      }
      const sessionToken = await makeToken({ sub: payload.sub, email: payload.email, ver: Number(payload.ver || 0), exp: Date.now() + 2592000000 }, env.AUTH_SECRET);
      await env.DB.prepare("UPDATE qr_sessions SET status = 'approved', token = ? WHERE id = ? AND status = 'pending'").bind(sessionToken, session).run();
      return reply({ status: "approved" });
    }

    if (path === "/artists" && request.method === "GET") {
      const rows = await all(env, "SELECT id, name, avatar_url FROM artists WHERE name LIKE ? ORDER BY " + sortOrder(url, ["name", "created_at"], "name") + " LIMIT ? OFFSET ?", [phrase(q), page.limit, page.offset]);
      return reply(rows);
    }

    if (path === "/albums" && request.method === "GET") {
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT a.id, a.title, a.artwork_url, a.release_date, ar.name AS artist FROM albums a JOIN artists ar ON ar.id = a.artist_id WHERE (a.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR ar.id = ?) AND EXISTS (SELECT 1 FROM releases r WHERE r.album_id = a.id AND r.status = 'published') ORDER BY " + sortOrder(url, ["title", "release_date"], "release_date", "a") + " LIMIT ? OFFSET ?", [phrase(q), phrase(q), artist, artist, page.limit, page.offset]);
      return reply(rows);
    }

    if (path === "/tracks" && request.method === "GET") {
      const album = url.searchParams.get("album") || "";
      const artist = url.searchParams.get("artist") || "";
      const rows = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, al.title AS album FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE (t.title LIKE ? OR ar.name LIKE ?) AND (? = '' OR t.album_id = ?) AND (? = '' OR t.artist_id = ?) AND " + publishedTrack("t") + " ORDER BY " + sortOrder(url, ["title", "duration"], "title", "t") + " LIMIT ? OFFSET ?", [phrase(q), phrase(q), album, album, artist, artist, page.limit, page.offset]);
      return reply(rows);
    }

    if (path.startsWith("/tracks/") && request.method === "GET") {
      const id = path.slice("/tracks/".length);
      const row = await one(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, al.title AS album FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.id = ? AND " + publishedTrack("t"), [id]);
      return row ? reply(row) : reply({ error: "not found" }, 404);
    }

    if (path === "/search" && request.method === "GET") {
      if (!q) return reply({ artists: [], albums: [], tracks: [] });
      const artists = await all(env, "SELECT id, name, avatar_url FROM artists WHERE name LIKE ? LIMIT 8", [phrase(q)]);
      const albums = await all(env, "SELECT a.id, a.title, a.artwork_url FROM albums a WHERE a.title LIKE ? AND EXISTS (SELECT 1 FROM releases r WHERE r.album_id = a.id AND r.status = 'published') LIMIT 8", [phrase(q)]);
      const tracks = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url FROM tracks t WHERE t.title LIKE ? AND " + publishedTrack("t") + " LIMIT 16", [phrase(q)]);
      return reply({ artists, albums, tracks });
    }

    if (path.startsWith("/lyrics/") && request.method === "GET") {
      const trackId = path.slice("/lyrics/".length);
      const row = await one(env, "SELECT l.language, l.text FROM lyrics l JOIN tracks t ON t.id = l.track_id WHERE l.track_id = ? AND l.status = 'published' AND " + publishedTrack("t"), [trackId]);
      return row ? reply(row) : reply({ error: "not found" }, 404);
    }

    if (path === "/releases" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return reply({ error: "forbidden" }, 403);
      const status = url.searchParams.get("status") || "";
      const rows = await all(env, "SELECT id, album_id, track_id, owner_id, status, reason, territory, license_type, updated_at FROM releases WHERE (? = '' OR status = ?) ORDER BY " + sortOrder(url, ["updated_at", "status"], "updated_at") + " LIMIT ? OFFSET ?", [status, status, page.limit, page.offset]);
      return reply(rows);
    }

    const statusMatch = path.match(/^\/(releases|lyrics)\/([^/]+)\/status$/);
    if (statusMatch && request.method === "POST") {
      if (!(await isAdmin(request, env))) return reply({ error: "forbidden" }, 403);
      const table = statusMatch[1];
      const id = statusMatch[2];
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const status = String(body && body.status || "");
      if (!statuses.includes(status)) return reply({ error: "invalid status" }, 400);
      const existing = await one(env, "SELECT id FROM " + table + " WHERE id = ?", [id]);
      if (!existing) return reply({ error: "not found" }, 404);
      const reason = String(body.reason || "");
      if (table === "releases") await env.DB.prepare("UPDATE releases SET status = ?, reason = ?, updated_at = datetime('now') WHERE id = ?").bind(status, reason, id).run();
      else await env.DB.prepare("UPDATE lyrics SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      await env.DB.prepare("INSERT INTO moderation_actions (id, target_type, target_id, action, actor, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), table, id, status, String(body.actor || "admin"), String(body.reason || "")).run();
      return reply({ id, status });
    }

    if (path === "/catalog/import" && request.method === "POST") {
      if (!(await isAdmin(request, env))) return reply({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
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
      return reply({ imported, skipped, errors });
    }

    if (path === "/catalog/duplicates" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return reply({ error: "forbidden" }, 403);
      const rows = await all(env, "SELECT lower(trim(t.title)) AS title_key, ar.name AS artist, COUNT(*) AS copies, GROUP_CONCAT(t.id) AS ids FROM tracks t JOIN artists ar ON ar.id = t.artist_id GROUP BY title_key, ar.name HAVING copies > 1 ORDER BY copies DESC LIMIT 100");
      return reply(rows);
    }

    if (path === "/analytics" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return reply({ error: "forbidden" }, 403);
      const tables = ["artists", "albums", "tracks", "releases", "lyrics", "rights", "users", "playlists", "listening_history", "moderation_actions"];
      const result = {};
      for (const table of tables) {
        const row = await one(env, "SELECT COUNT(*) AS total FROM " + table);
        result[table] = row ? Number(row.total) : 0;
      }
      return reply(result);
    }

    if (path === "/recommendations" && request.method === "GET") {
      const user = url.searchParams.get("user") || "";
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 12));
      if (!user) return reply([]);
      const rows = await all(env, "SELECT t.id, t.title, t.duration, t.artwork_url, ar.name AS artist, COUNT(h.id) AS score FROM tracks t JOIN artists ar ON ar.id = t.artist_id LEFT JOIN listening_history h ON h.user_id = ? AND h.track_id IN (SELECT id FROM tracks WHERE artist_id = t.artist_id) WHERE t.artist_id IN (SELECT t2.artist_id FROM tracks t2 JOIN listening_history h2 ON h2.track_id = t2.id WHERE h2.user_id = ?) AND t.id NOT IN (SELECT track_id FROM listening_history WHERE user_id = ?) AND " + publishedTrack("t") + " GROUP BY t.id ORDER BY score DESC, t.title LIMIT ?", [user, user, user, limit]);
      return reply(rows);
    }

    const followMatch = path.match(/^\/users\/([^/]+)\/follow$/);
    if (followMatch && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const follower = String(body && body.followerId || "").trim();
      const artist = followMatch[1];
      if (!follower || !artist) return reply({ error: "missing fields" }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, artist_id) VALUES (?, ?)").bind(follower, artist).run();
      return reply({ followerId: follower, artistId: artist, following: true });
    }
    if (followMatch && request.method === "DELETE") {
      const follower = url.searchParams.get("follower") || "";
      if (!follower) return reply({ error: "missing follower" }, 400);
      await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND artist_id = ?").bind(follower, followMatch[1]).run();
      return reply({ following: false });
    }

    const followingMatch = path.match(/^\/users\/([^/]+)\/following$/);
    if (followingMatch && request.method === "GET") {
      const rows = await all(env, "SELECT artist_id, created_at FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT ?", [followingMatch[1], page.limit]);
      return reply(rows);
    }

    const artistAnalytics = path.match(/^\/analytics\/artist\/([^/]+)$/);
    if (artistAnalytics && request.method === "GET") {
      const id = artistAnalytics[1];
      const plays = await one(env, "SELECT COUNT(*) AS total FROM listening_history h JOIN tracks t ON t.id = h.track_id WHERE t.artist_id = ?", [id]);
      const listeners = await one(env, "SELECT COUNT(DISTINCT h.user_id) AS total FROM listening_history h JOIN tracks t ON t.id = h.track_id WHERE t.artist_id = ?", [id]);
      const tracks = await one(env, "SELECT COUNT(*) AS total FROM tracks WHERE artist_id = ?", [id]);
      return reply({ artistId: id, plays: plays ? Number(plays.total) : 0, listeners: listeners ? Number(listeners.total) : 0, tracks: tracks ? Number(tracks.total) : 0 });
    }

    const offlineMatch = path.match(/^\/offline\/eligible\/([^/]+)$/);
    if (offlineMatch && request.method === "GET") {
      const row = await one(env, "SELECT r.offline_allowed, r.status, r.valid_until FROM releases r WHERE r.track_id = ? ORDER BY r.updated_at DESC LIMIT 1", [offlineMatch[1]]);
      const allowed = !!row && row.status === "published" && Number(row.offline_allowed) === 1 && (!row.valid_until || row.valid_until > new Date().toISOString().slice(0, 10));
      return reply({ trackId: offlineMatch[1], allowed });
    }

    const syncMatch = path.match(/^\/sync\/([^/]+)$/);
    if (syncMatch) {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      const owner = syncMatch[1];
      if (request.method === "GET") {
        const row = await one(env, "SELECT data, updated_at FROM sync_state WHERE owner_id = ?", [owner]);
        return row ? reply({ data: JSON.parse(row.data), updatedAt: row.updated_at }) : reply({ data: null });
      }
      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch (error) {
          return reply({ error: "invalid json" }, 400);
        }
        const data = JSON.stringify(body && body.data !== undefined ? body.data : body);
        if (data.length > 1048576) return reply({ error: "too large" }, 400);
        await env.DB.prepare("INSERT INTO sync_state (owner_id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')").bind(owner, data).run();
        return reply({ ownerId: owner, updated: true });
      }
    }

    if (path === "/reports" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const targetType = String(body && body.targetType || "");
      const targetId = String(body && body.targetId || "");
      const reason = String(body && body.reason || "").slice(0, 2000);
      if (!targetType || !targetId || !reason) return reply({ error: "missing fields" }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO moderation_actions (id, target_type, target_id, action, actor, reason) VALUES (?, ?, ?, ?, ?, ?)").bind(id, targetType, targetId, "report", "public", reason).run();
      return reply({ id, status: "pending review" });
    }

    if (path.startsWith("/studio/") && request.method === "GET") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      if (path === "/studio/releases") {
        const owner = url.searchParams.get("owner") || "";
        const rows = await all(env, "SELECT id, album_id, track_id, owner_id, status, reason, updated_at FROM releases WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?", [owner, page.limit, page.offset]);
        return reply(rows);
      }
      return reply({ error: "not found" }, 404);
    }

    if (path === "/studio/upload" && request.method === "POST") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      let form; try { form = await request.formData(); } catch (error) { return reply({ error: "invalid form" }, 400); }
      const file = form.get("file");
      if (!file || typeof file === "string") return reply({ error: "no file" }, 400);
      if (file.size > 52428800) return reply({ error: "file too large" }, 400);
      const buffer = await file.arrayBuffer();
      const type = sniffType(buffer);
      if (!type || !type.startsWith("audio/")) return reply({ error: "invalid type" }, 400);
      const key = "audio/" + crypto.randomUUID() + "." + typeExtensions[type];
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const sha256 = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      await env.MEDIA.put(key, buffer, { httpMetadata: { contentType: type }, customMetadata: { studio: "1", sha256: sha256 } });
      return reply({ key, sha256 });
    }

    if (path === "/studio/upload-cover" && request.method === "POST") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      let form; try { form = await request.formData(); } catch (error) { return reply({ error: "invalid form" }, 400); }
      const file = form.get("file");
      if (!file || typeof file === "string") return reply({ error: "no file" }, 400);
      if (file.size > 10485760) return reply({ error: "file too large" }, 400);
      const buffer = await file.arrayBuffer();
      const type = sniffType(buffer);
      if (!type || !type.startsWith("image/")) return reply({ error: "invalid type" }, 400);
      const key = "covers/" + crypto.randomUUID() + "." + typeExtensions[type];
      await env.MEDIA.put(key, buffer, { httpMetadata: { contentType: type }, customMetadata: { studio: "1" } });
      return reply({ key });
    }

    if (path === "/studio/tracks" && request.method === "POST") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const title = String(body && body.title || "").trim();
      const artistId = String(body && body.artistId || "").trim();
      const owner = String(body && body.ownerId || "").trim();
      const duration = Math.max(0, Number(body && body.duration) || 0);
      const audioKey = String(body && body.audioKey || "").trim();
      if (!title || !artistId || !owner || !/^audio\/[a-f0-9-]+\.[a-z0-9]+$/.test(audioKey)) return reply({ error: "missing fields" }, 400);
      const artist = await one(env, "SELECT id FROM artists WHERE id = ?", [artistId]);
      if (!artist) return reply({ error: "unknown artist" }, 404);
      const id = "tr-" + crypto.randomUUID();
      const releaseId = "rel-" + crypto.randomUUID();
      await env.DB.prepare("INSERT INTO tracks (id, artist_id, title, duration, audio_key, artwork_url) VALUES (?, ?, ?, ?, ?, ?)").bind(id, artistId, title, duration, audioKey, String(body.artworkUrl || "")).run();
      await env.DB.prepare("INSERT INTO releases (id, track_id, owner_id, status, territory, license_type) VALUES (?, ?, ?, 'draft', ?, ?)").bind(releaseId, id, owner, String(body.territory || ""), String(body.licenseType || "")).run();
      return reply({ id, releaseId, status: "draft" });
    }

    const trackMatch = path.match(/^\/studio\/tracks\/([^/]+)$/);
    if (trackMatch && request.method === "GET") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      const row = await one(env, "SELECT t.id, t.title, t.duration, t.artwork_url, r.status, r.reason FROM tracks t JOIN releases r ON r.track_id = t.id WHERE t.id = ?", [trackMatch[1]]);
      return row ? reply(row) : reply({ error: "not found" }, 404);
    }

    const editMatch = path.match(/^\/studio\/tracks\/([^/]+)$/);
    if (editMatch && request.method === "PATCH") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      let body;
      try {
        body = await request.json();
      } catch (error) {
        return reply({ error: "invalid json" }, 400);
      }
      const id = editMatch[1];
      const release = await one(env, "SELECT status FROM releases WHERE track_id = ?", [id]);
      if (!release) return reply({ error: "not found" }, 404);
      if (release.status !== "draft" && release.status !== "rejected") return reply({ error: "not editable" }, 409);
      const title = String(body && body.title || "").trim();
      const duration = Math.max(0, Number(body && body.duration) || 0);
      const artworkUrl = String(body && body.artworkUrl || "").trim();
      await env.DB.prepare("UPDATE tracks SET title = ?, duration = ?, artwork_url = ? WHERE id = ?").bind(title, duration, artworkUrl, id).run();
      if (release.status === "rejected") await env.DB.prepare("UPDATE releases SET status = 'draft', updated_at = datetime('now') WHERE track_id = ?").bind(id).run();
      return reply({ id, title, duration, artworkUrl });
    }

    const submitMatch = path.match(/^\/studio\/releases\/([^/]+)\/submit$/);
    if (submitMatch && request.method === "POST") {
      if (!(await hasStudioAccess(request, env))) return reply({ error: "forbidden" }, 403);
      const release = await one(env, "SELECT id, status FROM releases WHERE id = ?", [submitMatch[1]]);
      if (!release) return reply({ error: "not found" }, 404);
      if (release.status !== "draft" && release.status !== "rejected") return reply({ error: "invalid status" }, 400);
      await env.DB.prepare("UPDATE releases SET status = 'pending review', updated_at = datetime('now') WHERE id = ?").bind(release.id).run();
      return reply({ id: release.id, status: "pending review" });
    }

    return reply({ error: "not found" }, 404);
  }
};
