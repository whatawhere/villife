import worker from "../search-worker.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function request(path, headers) {
  return new Request("https://villife-search.telesamafia.workers.dev" + path, { headers });
}

Deno.test("warm returns version header", async () => {
  const response = await worker.fetch(request("/warm"), {});
  check(response.status === 200, "warm status");
  check(response.headers.get("X-Villife-Worker") === "7", "worker version");
});

Deno.test("debug reports r2 state", async () => {
  const response = await worker.fetch(request("/debug", { "X-Purge-Key": "test-secret" }), { PURGE_SECRET: "test-secret" });
  const data = await response.json();
  check(data.version === "7", "debug version");
  check(data.r2 === false, "debug r2");
});

Deno.test("search requires query", async () => {
  const response = await worker.fetch(request("/search"), {});
  check(response.status === 400, "search status");
});

Deno.test("stream validates id", async () => {
  const response = await worker.fetch(request("/stream?id=abc"), {});
  check(response.status === 400, "stream status");
});

Deno.test("hls rejects lookalike host", async () => {
  const target = "https://evil-soundcloud.com/segment.ts";
  const response = await worker.fetch(request("/hls?url=" + encodeURIComponent(target)), {});
  check(response.status === 403, "hls host status");
});

Deno.test("image rejects lookalike host", async () => {
  const target = "https://evil-sndcdn.com/cover.jpg";
  const response = await worker.fetch(request("/image?url=" + encodeURIComponent(target)), {});
  check(response.status === 403, "image host status");
});

Deno.test("image serves cached byte range", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const bucket = {
    get: async () => ({
      arrayBuffer: async () => bytes.buffer,
      httpMetadata: { contentType: "image/jpeg" }
    })
  };
  const target = "https://i1.sndcdn.com/cover.jpg";
  const path = "/image?url=" + encodeURIComponent(target);
  const response = await worker.fetch(request(path, { Range: "bytes=1-3" }), { MEDIA: bucket });
  check(response.status === 206, "range status");
  check(response.headers.get("Content-Range") === "bytes 1-3/5", "content range");
  check(response.headers.get("Accept-Ranges") === "bytes", "accept ranges");
  check(response.headers.get("X-Villife-Cache") === "HIT", "cache header");
  const body = new Uint8Array(await response.arrayBuffer());
  check(body.length === 3 && body[0] === 1 && body[2] === 3, "range body");
});

Deno.test("image serves suffix range", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const bucket = {
    get: async () => ({
      arrayBuffer: async () => bytes.buffer,
      httpMetadata: { contentType: "image/jpeg" }
    })
  };
  const target = "https://i1.sndcdn.com/cover.jpg";
  const path = "/image?url=" + encodeURIComponent(target);
  const response = await worker.fetch(request(path, { Range: "bytes=-2" }), { MEDIA: bucket });
  check(response.status === 206, "suffix status");
  check(response.headers.get("Content-Range") === "bytes 3-4/5", "suffix range");
});

Deno.test("image ignores unsatisfiable range", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const bucket = {
    get: async () => ({
      arrayBuffer: async () => bytes.buffer,
      httpMetadata: { contentType: "image/jpeg" }
    })
  };
  const target = "https://i1.sndcdn.com/cover.jpg";
  const path = "/image?url=" + encodeURIComponent(target);
  const response = await worker.fetch(request(path, { Range: "bytes=999-" }), { MEDIA: bucket });
  check(response.status === 200, "unsatisfiable status");
  check(new Uint8Array(await response.arrayBuffer()).length === 5, "full body");
});

Deno.test("hls rejects upstream failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 502 });
  try {
    const target = "https://i1.sndcdn.com/segment.ts";
    const response = await worker.fetch(request("/hls?url=" + encodeURIComponent(target)), {});
    check(response.status === 502, "upstream failure status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("search maps upstream tracks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    collection: [{ id: 42, title: "Track", full_duration: 180000, user: { id: 7, username: "Artist" } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const response = await worker.fetch(request("/search?q=test"), {});
    const data = await response.json();
    check(Array.isArray(data) && data.length === 1, "search result");
    check(data[0].id === "sc:42", "track id");
    check(data[0].artist === "Artist", "track artist");
    check(data[0].stream === "/api/stream?id=sc%3A42", "track stream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rate limit returns 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ collection: [] }), { status: 200 });
  try {
    let limited = false;
    for (let index = 0; index < 185; index++) {
      const response = await worker.fetch(request("/search?q=test", { "CF-Connecting-IP": "203.0.113.9" }), {});
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    check(limited, "rate limit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
