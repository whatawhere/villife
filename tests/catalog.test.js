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
          rows(sql, statement.params);
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

Deno.test("catalog applies sort and order", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured) };
  await worker.fetch(request("/tracks?sort=duration&order=desc"), env);
  const query = captured.find(item => item.sql.startsWith("SELECT t.id"));
  check(query.sql.includes("ORDER BY duration DESC"), "sort clause");
});

Deno.test("catalog imports valid tracks and rejects bad ones", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/catalog/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "secret" },
    body: JSON.stringify({ items: [
      { id: "tr-ok", title: "Song", artistId: "ar-1", duration: 120 },
      { id: "", title: "Bad", artistId: "ar-1" }
    ] })
  }), env);
  const data = await response.json();
  check(response.status === 200, "import status");
  check(data.imported === 1 && data.errors.length === 1, "import counts");
  check(captured.some(item => item.sql.startsWith("INSERT INTO tracks")), "import insert");
});

Deno.test("catalog finds duplicate tracks for admin", async () => {
  const env = { DB: makeDb(() => [{ title_key: "song", copies: 2 }], []), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/catalog/duplicates", { headers: { "X-Admin-Key": "secret" } }), env);
  const data = await response.json();
  check(response.status === 200, "duplicates status");
  check(data[0].copies === 2, "duplicates body");
});

Deno.test("catalog exposes analytics for admin", async () => {
  const env = { DB: makeDb((sql) => sql.startsWith("SELECT COUNT") ? [{ total: 7 }] : [], []), ADMIN_SECRET: "secret" };
  const response = await worker.fetch(request("/analytics", { headers: { "X-Admin-Key": "secret" } }), env);
  const data = await response.json();
  check(data.tracks === 7 && data.releases === 7, "analytics counts");
});

Deno.test("studio uploads cover", async () => {
  const stored = [];
  const env = { DB: makeDb(() => [], []), STUDIO_SECRET: "studio-secret", MEDIA: { put: async (key) => stored.push(key) } };
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2])], "cover.jpg", { type: "image/jpeg" }));
  const response = await worker.fetch(request("/studio/upload-cover", { method: "POST", headers: { "X-Studio-Key": "studio-secret" }, body: form }), env);
  const data = await response.json();
  check(/^covers\/[a-f0-9-]+\.jpg$/.test(data.key), "cover key");
  check(stored.length === 1, "cover stored");
});

Deno.test("studio edits draft track", async () => {
  const captured = [];
  const env = { DB: makeDb((sql) => sql.startsWith("SELECT status FROM releases") ? [{ status: "draft" }] : [], captured), STUDIO_SECRET: "studio-secret" };
  const response = await worker.fetch(request("/studio/tracks/tr-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Studio-Key": "studio-secret" },
    body: JSON.stringify({ title: "New title", duration: 200, artworkUrl: "covers/a.jpg" })
  }), env);
  const data = await response.json();
  check(response.status === 200, "edit status");
  check(data.title === "New title", "edit body");
  check(captured.some(item => item.sql.startsWith("UPDATE tracks")), "edit update");
});

Deno.test("catalog records rejection reason", async () => {
  const captured = [];
  const env = { DB: makeDb((sql) => sql.startsWith("SELECT id FROM releases") ? [{ id: "rel-1" }] : [], captured), ADMIN_SECRET: "secret" };
  await worker.fetch(request("/releases/rel-1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "secret" },
    body: JSON.stringify({ status: "rejected", reason: "no rights" })
  }), env);
  check(captured.some(item => item.sql.includes("reason = ?")), "reason stored");
});

Deno.test("auth requires configured secret", async () => {
  const env = { DB: makeDb(() => [], []) };
  const response = await worker.fetch(request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "password123" })
  }), env);
  check(response.status === 503, "auth unavailable");
});

Deno.test("auth register login and me", async () => {
  const captured = [];
  let user = null;
  const env = { DB: makeDb((sql, params) => {
    if (sql.startsWith("INSERT INTO users")) {
      user = { id: params[0], email: params[1], display_name: params[2], password_hash: params[3], salt: params[4], role: "user", token_version: 0 };
      return [];
    }
    if (sql.startsWith("SELECT id, email, display_name") && user) return [user];
    return [];
  }, captured), AUTH_SECRET: "test-secret" };
  const register = await worker.fetch(request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "password123", displayName: "A" })
  }), env);
  const registered = await register.json();
  check(register.status === 200 && registered.token, "registration token");
  check(captured.some(item => item.sql.startsWith("INSERT INTO users")), "user insert");

  const login = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "password123" })
  }), env);
  const logged = await login.json();
  check(login.status === 200 && logged.token, "login token");

  const me = await worker.fetch(request("/auth/me", { headers: { Authorization: "Bearer " + logged.token } }), env);
  const profile = await me.json();
  check(me.status === 200 && profile.email === "a@b.co", "me profile");
});

Deno.test("auth rejects wrong password", async () => {
  const env = { DB: makeDb(() => [{ id: "usr-1", email: "a@b.co", display_name: "A", password_hash: "00".repeat(32), salt: "11".repeat(16), role: "user", token_version: 0 }], []), AUTH_SECRET: "test-secret" };
  const response = await worker.fetch(request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "wrongpass" })
  }), env);
  check(response.status === 401, "wrong password");
});

Deno.test("email code login works in debug mode", async () => {
  let codeRow = null;
  let user = null;
  const env = { AUTH_SECRET: "test-secret", EMAIL_DEBUG: "1", DB: makeDb((sql, params) => {
    if (sql.startsWith("INSERT INTO email_codes")) {
      codeRow = { hash: params[1], expires: params[2] };
      return [];
    }
    if (sql.startsWith("SELECT hash, expires FROM email_codes")) return codeRow ? [codeRow] : [];
    if (sql.startsWith("DELETE FROM email_codes")) {
      codeRow = null;
      return [];
    }
    if (sql.startsWith("SELECT id, email, display_name, role, token_version FROM users")) return user ? [user] : [];
    if (sql.startsWith("INSERT INTO users")) {
      user = { id: params[0], email: params[1], display_name: params[2], role: "user", token_version: 0 };
      return [];
    }
    return [];
  }, []) };
  const requested = await worker.fetch(request("/auth/email/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "code@villife.test" })
  }), env);
  const challenge = await requested.json();
  check(requested.status === 200 && /^\d{6}$/.test(challenge.devCode), "code issued");
  const verified = await worker.fetch(request("/auth/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "code@villife.test", code: challenge.devCode })
  }), env);
  const result = await verified.json();
  check(verified.status === 200 && result.token, "email token");
});

Deno.test("qr login approves from phone", async () => {
  let session = null;
  let user = null;
  const env = { AUTH_SECRET: "test-secret", DB: makeDb((sql, params) => {
    if (sql.startsWith("INSERT INTO users")) {
      user = { id: params[0], email: params[1], display_name: params[2], password_hash: null, salt: null, role: "user", token_version: 0 };
      return [];
    }
    if (sql.startsWith("SELECT id, email, display_name, password_hash, salt, role, token_version FROM users")) return user ? [user] : [];
    if (sql.startsWith("INSERT INTO qr_sessions")) {
      session = { id: params[0], device: params[1], status: "pending", token: null, expires: params[4] };
      return [];
    }
    if (sql.startsWith("SELECT status, token, device, expires FROM qr_sessions") || sql.startsWith("SELECT expires, status FROM qr_sessions")) return session ? [session] : [];
    if (sql.startsWith("UPDATE qr_sessions SET status = 'approved'")) {
      session.status = "approved";
      session.token = params[0];
      return [];
    }
    return [];
  }, []) };
  const registered = await worker.fetch(request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "qr@villife.test", password: "password123" })
  }), env);
  const token = (await registered.json()).token;
  check(!!token, "phone token");

  const created = await worker.fetch(request("/auth/qr/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: "Windows 11" })
  }), env);
  const qr = await created.json();
  check(created.status === 200 && qr.device === "Windows 11", "qr session");

  const approved = await worker.fetch(request("/auth/qr/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ session: qr.session, decision: "approve" })
  }), env);
  check(approved.status === 200, "qr approve");

  const status = await worker.fetch(request("/auth/qr/status?session=" + qr.session), env);
  const state = await status.json();
  check(state.status === "approved" && state.token, "qr status token");
});

Deno.test("catalog recommends tracks by history", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [{ id: "tr-1", title: "Rec" }], captured) };
  const response = await worker.fetch(request("/recommendations?user=u1&limit=5"), env);
  const data = await response.json();
  check(response.status === 200, "recommendations status");
  check(data[0].id === "tr-1", "recommendations body");
  check(captured.some(item => item.sql.includes("listening_history")), "history query");
});

Deno.test("catalog follows artist", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured) };
  const response = await worker.fetch(request("/users/ar-1/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ followerId: "u1" })
  }), env);
  const data = await response.json();
  check(response.status === 200 && data.following === true, "follow result");
  check(captured.some(item => item.sql.startsWith("INSERT OR IGNORE INTO follows")), "follow insert");
});

Deno.test("catalog exposes artist analytics", async () => {
  const env = { DB: makeDb(() => [{ total: 9 }], []) };
  const response = await worker.fetch(request("/analytics/artist/ar-1"), env);
  const data = await response.json();
  check(data.plays === 9 && data.listeners === 9 && data.tracks === 9, "artist analytics");
});

Deno.test("catalog checks offline eligibility", async () => {
  const env = { DB: makeDb(() => [{ offline_allowed: 1, status: "published", valid_until: null }], []) };
  const response = await worker.fetch(request("/offline/eligible/tr-1"), env);
  const data = await response.json();
  check(data.allowed === true, "offline allowed");
});

Deno.test("catalog sync persists state", async () => {
  const captured = [];
  const env = { DB: makeDb(() => [], captured), STUDIO_SECRET: "studio-secret" };
  const response = await worker.fetch(request("/sync/u1", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Studio-Key": "studio-secret" },
    body: JSON.stringify({ data: { favorites: ["tr-1"] } })
  }), env);
  check(response.status === 200, "sync status");
  check(captured.some(item => item.sql.startsWith("INSERT INTO sync_state")), "sync insert");
});

Deno.test("catalog upload returns checksum", async () => {
  const env = { DB: makeDb(() => [], []), STUDIO_SECRET: "studio-secret", MEDIA: { put: async () => {} } };
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "song.mp3", { type: "audio/mpeg" }));
  const response = await worker.fetch(request("/studio/upload", { method: "POST", headers: { "X-Studio-Key": "studio-secret" }, body: form }), env);
  const data = await response.json();
  check(/^[a-f0-9]{64}$/.test(data.sha256), "checksum");
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
