import worker from "../catalog-worker.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function request(path, options) {
  return new Request("https://villife-catalog.telesamafia.workers.dev" + path, options);
}

function makeDb(rows, captured) {
  return {
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async all() {
          captured.push({ sql, params: statement.params });
          return { results: rows(sql, statement.params) };
        },
        async first() {
          captured.push({ sql, params: statement.params });
          const result = rows(sql, statement.params);
          return result[0] || null;
        },
        async run() {
          captured.push({ sql, params: statement.params });
          return { success: true };
        }
      };
      return statement;
    }
  };
}

Deno.test("catalog health reports bindings", async () => {
  const env = { DB: makeDb(() => [], []), MEDIA: {} };
  const response = await worker.fetch(request("/health"), env);
  const data = await response.json();
  check(data.ready === true, "health ready");
  check(data.db === true && data.r2 === true, "health bindings");
});

Deno.test("catalog search requires query", async () => {
  const env = { DB: makeDb(() => [], []) };
  const response = await worker.fetch(request("/search"), env);
  const data = await response.json();
  check(Array.isArray(data.tracks) && data.tracks.length === 0, "empty search");
});

Deno.test("catalog tracks query hides drafts", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured) };
  await worker.fetch(request("/tracks?q=test"), env);
  const query = captured.find(item => item.sql.startsWith("SELECT t.id"));
  check(!!query, "tracks query");
  check(query.sql.includes("r.status = 'published'"), "published filter");
});

Deno.test("catalog releases require admin", async () => {
  const env = { DB: makeDb(() => [], []), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/releases"), env);
  check(response.status === 403, "releases forbidden");
});

Deno.test("catalog status transition records moderation", async () => {
  const captured = [];
  const env = { DB: makeDb((sql) => sql.startsWith("SELECT id FROM") ? [{ id: "rel-1" }] : [], captured), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/releases/rel-1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "secret" },
    body: JSON.stringify({ status: "published", actor: "tester" })
  }), env);
  const data = await response.json();
  check(response.status === 200, "transition status");
  check(data.status === "published", "transition value");
  check(captured.some(item => item.sql.startsWith("UPDATE releases")), "update executed");
  check(captured.some(item => item.sql.startsWith("INSERT INTO moderation_actions")), "audit executed");
});

Deno.test("catalog accepts public report", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured) };
  const response = await worker.fetch(request("/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetType: "track", targetId: "tr-1", reason: "rights" })
  }), env);
  const data = await response.json();
  check(response.status === 200, "report status");
  check(data.status === "pending review", "report value");
  check(captured.some(item => item.sql.startsWith("INSERT INTO moderation_actions")), "report stored");
});

Deno.test("studio rejects requests without key", async () => {
  const env = { DB: makeDb(() => [], []), STUDIO_SECRET: "studio-secret" };
  const response = await worker.fetch(request("/studio/releases?owner=a"), env);
  check(response.status === 403, "studio forbidden");
});

Deno.test("studio upload stores file in r2", async () => {
  const stored = [];
  const env = {
    DB: makeDb(() => [], []),
    STUDIO_SECRET: "studio-secret",
    MEDIA: { put: async (key, value, options) => stored.push({ key, size: value.size, options }) }
  };
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "song.mp3", { type: "audio/mpeg" }));
  const response = await worker.fetch(request("/studio/upload", {
    method: "POST",
    headers: { "X-Studio-Key": "studio-secret" },
    body: form
  }), env);
  const data = await response.json();
  check(response.status === 200, "upload status");
  check(/^audio\/[a-f0-9-]+\.mp3$/.test(data.key), "upload key");
  check(stored.length === 1 && stored[0].options.httpMetadata.contentType === "audio/mpeg", "r2 put");
});

Deno.test("studio creates draft track and release", async () => {
  const captured = [];
  const env = { DB: makeDb((sql) => sql.startsWith("SELECT id FROM artists") ? [{ id: "ar-1" }] : [], captured), STUDIO_SECRET: "studio-secret" };
  const response = await worker.fetch(request("/studio/tracks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Studio-Key": "studio-secret" },
    body: JSON.stringify({ title: " Song ", artistId: "ar-1", ownerId: "user-1", duration: 120, audioKey: "audio/abc-123.mp3" })
  }), env);
  const data = await response.json();
  check(response.status === 200, "track status");
  check(data.status === "draft", "track draft");
  check(captured.some(item => item.sql.startsWith("INSERT INTO tracks")), "track insert");
  check(captured.some(item => item.sql.startsWith("INSERT INTO releases")), "release insert");
});

Deno.test("studio submits release for review", async () => {
  const captured = [];
  const env = {
    DB: makeDb((sql) => sql.startsWith("SELECT id, status FROM releases") ? [{ id: "rel-1", status: "draft" }] : [], captured),
    STUDIO_SECRET: "studio-secret"
  };
  const response = await worker.fetch(request("/studio/releases/rel-1/submit", {
    method: "POST",
    headers: { "X-Studio-Key": "studio-secret" }
  }), env);
  const data = await response.json();
  check(response.status === 200, "submit status");
  check(data.status === "pending review", "submit value");
  check(captured.some(item => item.sql.includes("'pending review'")), "submit update");
});

Deno.test("catalog rejects invalid status", async () => {
  const env = { DB: makeDb(() => [{ id: "rel-1" }], []), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/releases/rel-1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "secret" },
    body: JSON.stringify({ status: "unknown" })
  }), env);
  check(response.status === 400, "invalid status");
});
