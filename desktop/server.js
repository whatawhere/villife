const http = require("http");
const fs = require("fs");
const path = require("path");
const services = require("./services");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function webRoot() {
  const packaged = path.join(__dirname, "web");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "src");
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function handleApi(request, response, url) {
  const route = url.pathname;
  const param = name => url.searchParams.get(name) || "";

  if (route === "/api/search") {
    const term = param("q");
    if (!term) return sendError(response, 400, "no query");
    try {
      return sendJson(response, 200, await services.search(term));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/search/playlists") {
    const term = param("q");
    if (!term) return sendError(response, 400, "no query");
    try {
      return sendJson(response, 200, await services.searchPlaylists(term));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/playlist") {
    const id = param("id");
    if (!/^(?:sc-set:)?[0-9]+$/.test(id)) return sendError(response, 400, "invalid playlist id");
    try {
      return sendJson(response, 200, await services.playlistTracks(id));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/spotify/track" || route === "/api/spotify/playlist") {
    const id = param("id");
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return sendError(response, 400, "invalid Spotify id");
    try {
      const payload = route.endsWith("track")
        ? await services.spotifyTrack(id)
        : await services.spotifyPlaylist(id);
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/artist") {
    const id = param("id");
    const name = param("name");
    if ((id && !/^sc:[0-9]+$/.test(id)) || (!id && !name)) {
      return sendError(response, 400, "invalid artist id");
    }
    try {
      const payload = id ? await services.artist(id) : await services.artistByName(name);
      return sendJson(response, 200, payload);
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/lyrics") {
    const title = param("track_name");
    const artist = param("artist_name");
    if (!title || !artist) return sendError(response, 400, "track name and artist are required");
    const duration = Number.parseInt(param("duration"), 10);
    const safeDuration = Number.isFinite(duration) && duration >= 0 && duration <= 86400 ? duration : 0;
    try {
      return sendJson(response, 200, await services.lyrics(title, artist, safeDuration));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/youtube/search") {
    const term = param("q");
    if (!term || term.length > 240) return sendError(response, 400, "a track title and artist are required");
    if (!process.env.YOUTUBE_API_KEY) return sendError(response, 503, "YouTube Data API key is not configured.");
    try {
      return sendJson(response, 200, await services.youtubeSearch(term, process.env.YOUTUBE_API_KEY));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/oembed") {
    const target = param("url");
    if (!target) return sendError(response, 400, "a Spotify track URL is required");
    try {
      return sendJson(response, 200, await services.oembed(target));
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  if (route === "/api/warm") {
    const id = param("id");
    if (!id) return sendError(response, 400, "track id is required");
    return sendJson(response, 200, await services.warm(id));
  }

  if (route === "/api/stream") {
    const id = param("id");
    if (!id) return sendError(response, 400, "track id is required");
    try {
      const upstream = await services.streamRange(id, request.headers.range || "");
      if (!upstream) return sendError(response, 404, "stream is not available");
      const headers = {
        "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
        "Accept-Ranges": "bytes"
      };
      const length = upstream.headers.get("content-length");
      if (length) headers["Content-Length"] = length;
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) headers["Content-Range"] = contentRange;
      response.writeHead(upstream.status, headers);
      const body = upstream.body;
      if (body) {
        for await (const chunk of body) response.write(chunk);
      }
      response.end();
      return undefined;
    } catch (error) {
      return sendError(response, 502, String(error.message || error));
    }
  }

  return sendError(response, 404, "unknown endpoint");
}

function startServer() {
  const root = webRoot();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch(error => {
        try {
          sendError(response, 500, String(error.message || error));
        } catch {
          response.end();
        }
      });
      return;
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    if (file === "/villife.ico") {
      const icon = path.join(root, "..", "villife.ico");
      if (fs.existsSync(icon)) {
        const data = fs.readFileSync(icon);
        response.writeHead(200, { "Content-Type": MIME[".ico"], "Content-Length": data.length });
        response.end(data);
        return;
      }
    }

    const target = path.join(root, path.normalize(file).replace(/^([/\\])+/, ""));
    if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const data = fs.readFileSync(target);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache"
    });
    response.end(data);
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startServer };
