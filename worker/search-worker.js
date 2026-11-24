const FALLBACK_CLIENT_ID = "39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ";
let clientId = FALLBACK_CLIENT_ID;

const headers = {
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "X-Villife-Worker": "7"
};

const allowedOrigins = ["https://villife.hs.vc", "https://web.villife.hs.vc", "http://localhost:5173", "http://127.0.0.1:8080"];

function allowedOrigin(request) {
  const origin = request && request.headers ? request.headers.get("Origin") : null;
  return origin && allowedOrigins.includes(origin) ? origin : null;
}

function responseHeaders(request) {
  const result = Object.assign({}, headers, {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  const origin = allowedOrigin(request);
  if (origin) {
    result["Access-Control-Allow-Origin"] = origin;
    result["Vary"] = "Origin";
  }
  return result;
}

function media(env) {
  return env && env.MEDIA ? env.MEDIA : null;
}

async function cacheKey(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function cachedResponse(env, key, request) {
  const bucket = media(env);
  if (!bucket) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  const buffer = await object.arrayBuffer();
  return serveBytes(buffer, (object.httpMetadata && object.httpMetadata.contentType) || "application/octet-stream", request, {
    "X-Villife-Cache": "HIT"
  });
}

async function storeResponse(env, key, bytes, contentType) {
  const bucket = media(env);
  if (!bucket) return;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentType || "application/octet-stream" },
    customMetadata: { cached: "1" }
  });
}

function json(value, status, request) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: Object.assign(responseHeaders(request), { "Content-Type": "application/json; charset=utf-8" })
  });
}

async function refreshClientId() {
  try {
    const page = await fetch("https://soundcloud.com/");
    const text = await page.text();
    const match = text.match(/client_id:"([a-zA-Z0-9]+)"/);
    if (match && match[1]) clientId = match[1];
  } catch (error) {
    console.error("client id refresh failed", error && error.message);
  }
}

async function soundcloud(path, options) {
  const build = () => "https://api-v2.soundcloud.com/" + path + (path.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(clientId);
  let response = await fetch(build(), options);
  if (response.status === 401 || response.status === 403) {
    await refreshClientId();
    response = await fetch(build(), options);
  }
  return response;
}

function artwork(value) {
  const src = String(value || "");
  return src ? src.replace("-large.", "-t500x500.").replace("i1.sndcdn.com", "i2.sndcdn.com") : "";
}

function proxyArt(item, base) {
  ["artwork", "avatar"].forEach(key => {
    if (item[key]) item[key] = base + "/image?url=" + encodeURIComponent(String(item[key]));
  });
  return item;
}

function mapTrack(item) {
  const user = item.user || {};
  const id = item.id || 0;
  const duration = Number(item.full_duration || item.duration || 0);
  return {
    id: "sc:" + id,
    title: item.title || "",
    artist: user.username || "",
    artistId: user.id ? "sc:" + user.id : "",
    avatar: user.avatar_url || "",
    artwork: artwork(item.artwork_url || user.avatar_url),
    duration: Math.round(duration / 1000),
    preview: "",
    stream: "/api/stream?id=" + encodeURIComponent("sc:" + id),
    url: item.permalink_url || "",
    source: "soundcloud"
  };
}

function mapPlaylist(item) {
  const user = item.user || {};
  const tracks = Array.isArray(item.tracks) ? item.tracks : [];
  const cover = item.artwork_url || (tracks[0] && tracks[0].artwork_url) || user.avatar_url || "";
  const date = item.release_date || item.created_at || "";
  const album = !!item.is_album || String(item.set_type || "").toLowerCase() === "album";
  return {
    id: "sc-set:" + (item.id || 0),
    title: item.title || "",
    artist: user.username || "",
    artistId: user.id ? "sc:" + user.id : "",
    artwork: artwork(cover),
    trackCount: Number(item.track_count || tracks.length || 0),
    year: date ? String(date).slice(0, 4) : "",
    type: album ? "album" : "playlist"
  };
}

function okResponse(bytes, contentType, cacheControl, request) {
  const extra = cacheControl ? { "Cache-Control": cacheControl } : {};
  return new Response(bytes, {
    status: 200,
    headers: Object.assign(responseHeaders(request), { "Content-Type": contentType || "application/octet-stream" }, extra)
  });
}

function allowedHost(host, suffixes) {
  const value = String(host || "").toLowerCase();
  return suffixes.some(suffix => value === suffix || value.endsWith("." + suffix));
}

function rangeSlice(request, size) {
  const value = request && request.headers ? request.headers.get("Range") : "";
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || "").trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return null;
  return { start: start, end: Math.min(end, size - 1) };
}

function serveBytes(bytes, contentType, request, extra) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const size = buffer.byteLength;
  const slice = rangeSlice(request, size);
  const result = Object.assign(responseHeaders(request), {
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": slice ? String(slice.end - slice.start + 1) : String(size),
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "CDN-Cache-Control": "public, max-age=604800"
  }, extra || {});
  if (slice) {
    result["Content-Range"] = "bytes " + slice.start + "-" + slice.end + "/" + size;
    return new Response(buffer.slice(slice.start, slice.end + 1), { status: 206, headers: result });
  }
  return new Response(buffer, { status: 200, headers: result });
}

function passthrough(response, request) {
  const result = new Headers();
  response.headers.forEach((value, name) => result.set(name, value));
  Object.keys(responseHeaders(request)).forEach(name => result.set(name, responseHeaders(request)[name]));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: result });
}

const rateBuckets = new Map();
function rateLimit(request, scope, limit) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const now = Date.now();
  const key = scope + ":" + ip;
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > 60000) {
    rateBuckets.set(key, { start: now, count: 1 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return json({ error: "too many requests" }, 429, request);
  }
  return null;
}

async function proxyHls(targetUrl, base, depth, env, key, request) {
  if (depth > 4) return json({ error: "too many redirects" }, 502, request);
  const host = targetUrl.hostname.toLowerCase();
  if (!allowedHost(host, ["soundcloud.com", "sndcdn.com", "soundcloud.cloud"])) return json({ error: "forbidden" }, 403, request);
  if (key) {
    const hit = await cachedResponse(env, key, request);
    if (hit) return hit;
  }
  const range = request && request.headers ? request.headers.get("Range") : null;
  const response = await fetch(targetUrl.toString(), { redirect: "follow", headers: range ? { Range: range } : {} });
  if (response.status === 206) return passthrough(response);
  if (!response.ok) {
    console.error("hls upstream failed", host, response.status);
    return json({ error: "upstream failed" }, 502, request);
  }
  const type = response.headers.get("Content-Type") || "";
  const clone = response.clone();
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("#EXTM3U")) {
    const rewritten = text.split("\n").map(line => {
      const value = line.trim();
      if (!value || value.startsWith("#")) return line;
      let absolute;
      try {
        absolute = new URL(value, targetUrl).toString();
      } catch (error) {
        return line;
      }
      if (!allowedHost(new URL(absolute).hostname, ["soundcloud.cloud"])) {
        absolute += (absolute.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(clientId);
      }
      return base + "/hls?url=" + encodeURIComponent(absolute);
    }).join("\n");
    const bytes = new TextEncoder().encode(rewritten);
    if (key) await storeResponse(env, key, bytes, "application/vnd.apple.mpegurl");
    return okResponse(bytes, "application/vnd.apple.mpegurl", null, request);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let next;
    try {
      next = new URL(trimmed);
    } catch (error) {
      return json({ error: "invalid url" }, 400, request);
    }
    return proxyHls(next, base, depth + 1, env, key, request);
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.url) {
        const next = new URL(String(parsed.url));
        return proxyHls(next, base, depth + 1, env, key, request);
      }
    } catch (error) {}
  }
  const buffer = await clone.arrayBuffer();
  if (key) await storeResponse(env, key, buffer, type || "application/octet-stream");
  return serveBytes(buffer, type || "application/octet-stream", request, { "X-Villife-Cache": "MISS" });
}

export default {
  async fetch(request, env) {
    const reply = (value, status) => json(value, status, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders(request) });
    const url = new URL(request.url);
    if (env && env.SC_CLIENT_ID) clientId = env.SC_CLIENT_ID;
    const q = url.searchParams.get("q") || "";
    const id = url.searchParams.get("id") || "";
    if (url.pathname === "/search") {
      const limited = rateLimit(request, "search", 180);
      if (limited) return limited;
      if (!q) return reply({ error: "no query" }, 400);
      const response = await soundcloud("search/tracks?q=" + encodeURIComponent(q) + "&limit=24");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.filter(item => item.streamable !== false).map(item => proxyArt(mapTrack(item), url.origin)) : [];
      return reply(list);
    }
    if (url.pathname === "/search/playlists") {
      const limited = rateLimit(request, "search", 180);
      if (limited) return limited;
      if (!q) return reply({ error: "no query" }, 400);
      const response = await soundcloud("search/playlists?q=" + encodeURIComponent(q) + "&limit=12");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.map(item => proxyArt(mapPlaylist(item), url.origin)) : [];
      return reply(list);
    }
    if (url.pathname === "/stream") {
      const limited = rateLimit(request, "stream", 120);
      if (limited) return limited;
      const numeric = String(id).replace(/^sc:/, "");
      if (!/^\d+$/.test(numeric)) return reply({ error: "invalid id" }, 400);
      const trackResponse = await soundcloud("tracks/" + numeric);
      if (!trackResponse.ok) return reply({ error: "track unavailable" }, 502);
      const track = await trackResponse.json();
      const transcodings = (track.media && track.media.transcodings) || [];
      const hls = transcodings.find(item => item.format && String(item.format.protocol || "").toLowerCase() === "hls");
      if (!hls || !hls.url) return reply({ error: "stream unavailable" }, 502);
      const source = hls.url + (hls.url.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(clientId);
      const playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n" + url.origin + "/hls?url=" + encodeURIComponent(source) + "\n";
      return okResponse(new TextEncoder().encode(playlist), "application/vnd.apple.mpegurl", null, request);
    }
    if (url.pathname === "/hls") {
      const limited = rateLimit(request, "hls", 300);
      if (limited) return limited;
      const target = url.searchParams.get("url") || "";
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch (error) {
        return reply({ error: "invalid url" }, 400);
      }
      const key = await cacheKey(targetUrl.origin + targetUrl.pathname);
      return proxyHls(targetUrl, url.origin, 0, env, key, request);
    }
    if (url.pathname === "/debug") {
      if (!env.PURGE_SECRET || request.headers.get("X-Purge-Key") !== env.PURGE_SECRET) return reply({ error: "not found" }, 404);
      const bucket = media(env);
      let objects = null;
      let error = null;
      try {
        if (bucket) {
          const listed = await bucket.list();
          objects = listed.objects.length;
        }
      } catch (failure) {
        error = String(failure);
      }
      return reply({ version: "7", r2: !!bucket, objects: objects, error: error });
    }
    if (url.pathname === "/purge") {
      const bucket = media(env);
      const key = url.searchParams.get("key") || "";
      if (!bucket || !env.PURGE_SECRET || request.headers.get("X-Purge-Key") !== env.PURGE_SECRET || !/^[a-f0-9]{64}$/.test(key)) {
        return reply({ error: "not found" }, 404);
      }
      await bucket.delete(key);
      return reply({ purged: key });
    }
    if (url.pathname === "/warm") return reply({ ready: true });
    if (url.pathname === "/artist") {
      const limited = rateLimit(request, "search", 180);
      if (limited) return limited;
      const name = url.searchParams.get("name") || "";
      if (!name) return reply([], 200);
      const response = await soundcloud("search/users?q=" + encodeURIComponent(name) + "&limit=5");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.map(user => ({ id: "sc:" + user.id, name: user.username || "" })) : [];
      return reply(list);
    }
    if (url.pathname === "/image") {
      const limited = rateLimit(request, "image", 240);
      if (limited) return limited;
      const target = url.searchParams.get("url") || "";
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch (error) {
        return reply({ error: "invalid url" }, 400);
      }
      const host = targetUrl.hostname.toLowerCase();
      if (!allowedHost(host, ["soundcloud.com", "sndcdn.com"])) return reply({ error: "forbidden" }, 403);
      const key = await cacheKey(targetUrl.toString());
      const hit = await cachedResponse(env, key, request);
      if (hit) return hit;
      const range = request.headers.get("Range");
      const response = await fetch(targetUrl.toString(), { redirect: "follow", headers: range ? { Range: range } : {} });
      if (response.status === 206) return passthrough(response, request);
      if (!response.ok) {
        console.error("image upstream failed", host, response.status);
        return reply({ error: "image unavailable" }, 502);
      }
      const type = response.headers.get("Content-Type") || "image/jpeg";
      const buffer = await response.arrayBuffer();
      await storeResponse(env, key, buffer, type);
      return serveBytes(buffer, type, request, { "X-Villife-Cache": "MISS" });
    }
    return reply({ error: "not found" }, 404);
  }
};
