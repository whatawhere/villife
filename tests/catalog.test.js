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

Deno.test("catalog rejects invalid status", async () => {
  const env = { DB: makeDb(() => [{ id: "rel-1" }], []), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/releases/rel-1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "secret" },
    body: JSON.stringify({ status: "unknown" })
  }), env);
  check(response.status === 400, "invalid status");
});
