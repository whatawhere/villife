const FALLBACK_CLIENT_ID = "39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ";
let clientId = FALLBACK_CLIENT_ID;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "X-Villife-Worker": "6"
};

function media(env) {
  return env && env.MEDIA ? env.MEDIA : null;
}

async function cacheKey(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function cachedResponse(env, key) {
  const bucket = media(env);
  if (!bucket) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  return new Response(object.body, {
    status: 200,
    headers: Object.assign({}, headers, {
      "Content-Type": (object.httpMetadata && object.httpMetadata.contentType) || "application/octet-stream",
      "Cache-Control": "public, max-age=86400"
    })
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

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: Object.assign({}, headers, { "Content-Type": "application/json; charset=utf-8" })
  });
}

async function refreshClientId() {
  try {
    const page = await fetch("https://soundcloud.com/");
    const text = await page.text();
    const match = text.match(/client_id:"([a-zA-Z0-9]+)"/);
    if (match && match[1]) clientId = match[1];
  } catch (error) {}
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

function okResponse(bytes, contentType, cacheControl) {
  const extra = cacheControl ? { "Cache-Control": cacheControl } : {};
  return new Response(bytes, {
    status: 200,
    headers: Object.assign({}, headers, { "Content-Type": contentType || "application/octet-stream" }, extra)
  });
}

async function proxyHls(targetUrl, base, depth, env, key) {
  if (depth > 4) return json({ error: "too many redirects" }, 502);
  const host = targetUrl.hostname.toLowerCase();
  if (!host.endsWith("soundcloud.com") && !host.endsWith("sndcdn.com") && !host.endsWith("soundcloud.cloud")) return json({ error: "forbidden" }, 403);
  if (key) {
    const hit = await cachedResponse(env, key);
    if (hit) return hit;
  }
  const response = await fetch(targetUrl.toString(), { redirect: "follow" });
  if (!response.ok) return json({ error: "upstream failed" }, 502);
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
      if (!new URL(absolute).hostname.toLowerCase().endsWith("soundcloud.cloud")) {
        absolute += (absolute.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(clientId);
      }
      return base + "/hls?url=" + encodeURIComponent(absolute);
    }).join("\n");
    const bytes = new TextEncoder().encode(rewritten);
    if (key) await storeResponse(env, key, bytes, "application/vnd.apple.mpegurl");
    return okResponse(bytes, "application/vnd.apple.mpegurl");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let next;
    try {
      next = new URL(trimmed);
    } catch (error) {
      return json({ error: "invalid url" }, 400);
    }
    return proxyHls(next, base, depth + 1, env, key);
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.url) {
        const next = new URL(String(parsed.url));
        return proxyHls(next, base, depth + 1, env, key);
      }
    } catch (error) {}
  }
  const buffer = await clone.arrayBuffer();
  if (key) await storeResponse(env, key, buffer, type || "application/octet-stream");
  return okResponse(buffer, type || "application/octet-stream");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: headers });
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const id = url.searchParams.get("id") || "";
    if (url.pathname === "/search") {
      if (!q) return json({ error: "no query" }, 400);
      const response = await soundcloud("search/tracks?q=" + encodeURIComponent(q) + "&limit=24");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.filter(item => item.streamable !== false).map(item => proxyArt(mapTrack(item), url.origin)) : [];
      return json(list);
    }
    if (url.pathname === "/search/playlists") {
      if (!q) return json({ error: "no query" }, 400);
      const response = await soundcloud("search/playlists?q=" + encodeURIComponent(q) + "&limit=12");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.map(item => proxyArt(mapPlaylist(item), url.origin)) : [];
      return json(list);
    }
    if (url.pathname === "/stream") {
      const numeric = String(id).replace(/^sc:/, "");
      if (!/^\d+$/.test(numeric)) return json({ error: "invalid id" }, 400);
      const trackResponse = await soundcloud("tracks/" + numeric);
      if (!trackResponse.ok) return json({ error: "track unavailable" }, 502);
      const track = await trackResponse.json();
      const transcodings = (track.media && track.media.transcodings) || [];
      const hls = transcodings.find(item => item.format && String(item.format.protocol || "").toLowerCase() === "hls");
      if (!hls || !hls.url) return json({ error: "stream unavailable" }, 502);
      const source = hls.url + (hls.url.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(clientId);
      const playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n" + url.origin + "/hls?url=" + encodeURIComponent(source) + "\n";
      return okResponse(new TextEncoder().encode(playlist), "application/vnd.apple.mpegurl");
    }
    if (url.pathname === "/hls") {
      const target = url.searchParams.get("url") || "";
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch (error) {
        return json({ error: "invalid url" }, 400);
      }
      const key = await cacheKey(targetUrl.origin + targetUrl.pathname);
      return proxyHls(targetUrl, url.origin, 0, env, key);
    }
    if (url.pathname === "/debug") {
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
      return json({ version: "6", r2: !!bucket, objects: objects, error: error });
    }
    if (url.pathname === "/warm") return json({ ready: true });
    if (url.pathname === "/artist") {
      const name = url.searchParams.get("name") || "";
      if (!name) return json([], 200);
      const response = await soundcloud("search/users?q=" + encodeURIComponent(name) + "&limit=5");
      const data = await response.json();
      const list = Array.isArray(data.collection) ? data.collection.map(user => ({ id: "sc:" + user.id, name: user.username || "" })) : [];
      return json(list);
    }
    if (url.pathname === "/image") {
      const target = url.searchParams.get("url") || "";
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch (error) {
        return json({ error: "invalid url" }, 400);
      }
      const host = targetUrl.hostname.toLowerCase();
      if (!host.endsWith("soundcloud.com") && !host.endsWith("sndcdn.com")) return json({ error: "forbidden" }, 403);
      const key = await cacheKey(targetUrl.toString());
      const hit = await cachedResponse(env, key);
      if (hit) return hit;
      const response = await fetch(targetUrl.toString(), { redirect: "follow" });
      if (!response.ok) return json({ error: "image unavailable" }, 502);
      const buffer = await response.arrayBuffer();
      await storeResponse(env, key, buffer, response.headers.get("Content-Type") || "image/jpeg");
      return okResponse(buffer, response.headers.get("Content-Type") || "image/jpeg", "public, max-age=86400");
    }
    return json({ error: "not found" }, 404);
  }
};
